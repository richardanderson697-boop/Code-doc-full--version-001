// Tenant-isolation tests: the adversarial checks. User A creates data; user B
// must not be able to read, list, overwrite, or delete it, and anonymous
// callers must be rejected outright. These encode the invariant every piece
// of user-owned data has an owner, and every access proves ownership.
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import AdmZip from "adm-zip";

import authRouter from "../server/routes/auth";
import projectsRouter from "../server/routes/projects";
import workspaceRouter from "../server/routes/workspace";
import { initProjectsStore } from "../server/db";
import { initAuthStore } from "../server/authdb";

function buildApp() {
  const app = express();
  const jsonDefault = express.json({ limit: "10mb" });
  const jsonZipUpload = express.json({ limit: "100mb" });
  app.use((req, res, next) =>
    req.path === "/api/upload-zip" ? jsonZipUpload(req, res, next) : jsonDefault(req, res, next)
  );
  app.use(authRouter);
  app.use(projectsRouter);
  app.use(workspaceRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status || 500).json({ error: err?.message || "server error" });
  });
  return app;
}

let userCounter = 0;
async function userCookie(app: any): Promise<string> {
  userCounter += 1;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `tenant-${userCounter}@x.io`, password: "supersecret1" });
  expect(res.status).toBe(201);
  const raw = res.headers["set-cookie"];
  const setCookie: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = setCookie.find((c) => c.startsWith("codedoc_session="));
  expect(session).toBeTruthy();
  return session!.split(";")[0];
}

function tinyZip(): string {
  const zip = new AdmZip();
  zip.addFile("src/secret.ts", Buffer.from("export const password = 'hunter2';\n"));
  return zip.toBuffer().toString("base64");
}

beforeAll(() => {
  initProjectsStore();
  initAuthStore();
});

describe("anonymous callers are rejected on data routes", () => {
  const cases: Array<[string, string, any?]> = [
    ["post", "/api/upload-zip", { zipBase64: tinyZip() }],
    ["post", "/api/clear-upload"],
    ["get", "/api/upload-status"],
    ["get", "/api/uploaded-file?path=src/secret.ts"],
    ["post", "/api/save-workspace-file", { filePath: "x.ts", content: "x" }],
    ["post", "/api/delete-workspace-file", { filePath: "x.ts" }],
    ["get", "/api/projects"],
    ["post", "/api/projects", { title: "t", prompt: "p" }],
    ["delete", "/api/projects/whatever"],
  ];
  for (const [method, url, body] of cases) {
    it(`401 on ${method.toUpperCase()} ${url}`, async () => {
      const app = buildApp();
      let r: any = request(app)[method](url);
      if (body) r = r.send(body);
      const res = await r;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("AUTH_REQUIRED");
    });
  }
});

describe("uploaded workspaces are per-user", () => {
  it("user B sees nothing of user A's uploaded codebase", async () => {
    const app = buildApp();
    const cookieA = await userCookie(app);
    const cookieB = await userCookie(app);

    const up = await request(app)
      .post("/api/upload-zip")
      .set("Cookie", cookieA)
      .send({ zipBase64: tinyZip() });
    expect(up.status).toBe(200);

    const statusB = await request(app).get("/api/upload-status").set("Cookie", cookieB);
    expect(statusB.status).toBe(200);
    expect(statusB.body.uploaded).toBe(false);
    expect(statusB.body.files).toEqual([]);

    const statusA = await request(app).get("/api/upload-status").set("Cookie", cookieA);
    expect(statusA.body.uploaded).toBe(true);
    expect(statusA.body.files.some((f: any) => f.path === "src/secret.ts")).toBe(true);
  });

  it("user B cannot read user A's file contents", async () => {
    const app = buildApp();
    const cookieA = await userCookie(app);
    const cookieB = await userCookie(app);

    await request(app).post("/api/upload-zip").set("Cookie", cookieA).send({ zipBase64: tinyZip() });

    const res = await request(app)
      .get("/api/uploaded-file")
      .query({ path: "src/secret.ts" })
      .set("Cookie", cookieB);
    // B has no such file in their own workspace: 404, never A's bytes.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });

  it("user B clearing their workspace leaves user A's intact", async () => {
    const app = buildApp();
    const cookieA = await userCookie(app);
    const cookieB = await userCookie(app);

    await request(app).post("/api/upload-zip").set("Cookie", cookieA).send({ zipBase64: tinyZip() });
    const clear = await request(app).post("/api/clear-upload").set("Cookie", cookieB);
    expect(clear.status).toBe(200);

    const statusA = await request(app).get("/api/upload-status").set("Cookie", cookieA);
    expect(statusA.body.uploaded).toBe(true);
  });

  it("user B cannot overwrite user A's files via save-workspace-file", async () => {
    const app = buildApp();
    const cookieA = await userCookie(app);
    const cookieB = await userCookie(app);

    await request(app).post("/api/upload-zip").set("Cookie", cookieA).send({ zipBase64: tinyZip() });
    await request(app)
      .post("/api/save-workspace-file")
      .set("Cookie", cookieB)
      .send({ filePath: "src/secret.ts", content: "pwned" });

    const readA = await request(app)
      .get("/api/uploaded-file")
      .query({ path: "src/secret.ts" })
      .set("Cookie", cookieA);
    expect(readA.body.content).toContain("hunter2");
    expect(readA.body.content).not.toContain("pwned");
  });
});

describe("project ledger is per-user", () => {
  it("user B cannot list, delete, or overwrite user A's projects", async () => {
    const app = buildApp();
    const cookieA = await userCookie(app);
    const cookieB = await userCookie(app);

    const created = await request(app)
      .post("/api/projects")
      .set("Cookie", cookieA)
      .send({ title: "A's project", prompt: "do things", code: "secret-code" });
    expect(created.status).toBe(200);
    const id = created.body.project.id;
    expect(created.body.project.userId).toBeTruthy();

    // B's list does not contain it.
    const listB = await request(app).get("/api/projects").set("Cookie", cookieB);
    expect(listB.body.some((p: any) => p.id === id)).toBe(false);

    // B cannot delete it: 404, and it is still there for A.
    const delB = await request(app).delete(`/api/projects/${id}`).set("Cookie", cookieB);
    expect(delB.status).toBe(404);
    const listA = await request(app).get("/api/projects").set("Cookie", cookieA);
    expect(listA.body.some((p: any) => p.id === id)).toBe(true);

    // B cannot overwrite it by reusing the id: 404, A's data unchanged.
    const steal = await request(app)
      .post("/api/projects")
      .set("Cookie", cookieB)
      .send({ id, title: "stolen", prompt: "p" });
    expect(steal.status).toBe(404);
    const readA = await request(app).get("/api/projects").set("Cookie", cookieA);
    expect(readA.body.find((p: any) => p.id === id).title).toBe("A's project");
  });

  it("a user can still fully manage their own projects", async () => {
    const app = buildApp();
    const cookie = await userCookie(app);

    const created = await request(app)
      .post("/api/projects")
      .set("Cookie", cookie)
      .send({ title: "mine", prompt: "p", code: "c" });
    const id = created.body.project.id;

    const updated = await request(app)
      .post("/api/projects")
      .set("Cookie", cookie)
      .send({ id, title: "mine v2", prompt: "p" });
    expect(updated.status).toBe(200);
    expect(updated.body.project.title).toBe("mine v2");

    const del = await request(app).delete(`/api/projects/${id}`).set("Cookie", cookie);
    expect(del.status).toBe(200);
    const list = await request(app).get("/api/projects").set("Cookie", cookie);
    expect(list.body.some((p: any) => p.id === id)).toBe(false);
  });
});
