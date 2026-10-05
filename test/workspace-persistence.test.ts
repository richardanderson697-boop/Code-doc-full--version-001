// Workspace persistence tests: files live in Postgres/SQLite (workspace_files),
// not on disk, so they survive redeploys. These exercise the CRUD roundtrip,
// ZIP ingest, tenant isolation, and path validation through the HTTP API.
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import AdmZip from "adm-zip";

import authRouter from "../server/routes/auth";
import workspaceRouter from "../server/routes/workspace";
import { initStore } from "../server/store";
import { cleanWorkspacePath, isWorkspaceFileExt } from "../server/workspace";

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "100mb" }));
  app.use(authRouter);
  app.use(workspaceRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status || 500).json({ error: err?.message || "server error" });
  });
  return app;
}

beforeAll(async () => {
  await initStore();
});

let cookieCounter = 0;
async function authedCookie(app: any): Promise<string> {
  cookieCounter += 1;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `wspersist-test-${cookieCounter}@x.io`, password: "supersecret1" });
  expect(res.status).toBe(201);
  const raw = res.headers["set-cookie"];
  const setCookie: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = setCookie.find((c) => c.startsWith("codedoc_session="));
  expect(session).toBeTruthy();
  return session!.split(";")[0];
}

function makeZip(files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer().toString("base64");
}

describe("cleanWorkspacePath", () => {
  it("normalizes redundant segments and backslashes", () => {
    expect(cleanWorkspacePath("src//a/./b.ts")).toBe("src/a/b.ts");
    expect(cleanWorkspacePath("src\\a\\b.ts")).toBe("src/a/b.ts");
    expect(cleanWorkspacePath("/src/a.ts")).toBe("src/a.ts");
    expect(cleanWorkspacePath("src/a/../b.ts")).toBe("src/b.ts");
  });
  it("rejects escapes, absolutes, and empties", () => {
    expect(cleanWorkspacePath("../evil.ts")).toBeNull();
    expect(cleanWorkspacePath("a/../../evil.ts")).toBeNull();
    expect(cleanWorkspacePath("")).toBeNull();
    expect(cleanWorkspacePath("   ")).toBeNull();
    expect(cleanWorkspacePath(null)).toBeNull();
    expect(cleanWorkspacePath("nul\0byte")).toBeNull();
  });
});

describe("isWorkspaceFileExt", () => {
  it("tracks SQL schema files so the model sees them instead of guessing", () => {
    expect(isWorkspaceFileExt("migrations/001_init.sql")).toBe(true);
    expect(isWorkspaceFileExt("src/App.tsx")).toBe(true);
    expect(isWorkspaceFileExt("assets/logo.png")).toBe(false);
  });
});

describe("workspace file CRUD", () => {
  it("roundtrips save -> status -> read -> delete", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);

    const save = await request(app)
      .post("/api/save-workspace-file")
      .set("Cookie", cookie)
      .send({ filePath: "src/a.ts", content: "export const a = 1;\n" });
    expect(save.status).toBe(200);
    expect(save.body.filePath).toBe("src/a.ts");
    expect(save.body.lineCount).toBe(1);

    const status = await request(app).get("/api/upload-status").set("Cookie", cookie);
    expect(status.body.uploaded).toBe(true);
    expect(status.body.files).toHaveLength(1);
    expect(status.body.files[0].path).toBe("src/a.ts");

    const read = await request(app)
      .get("/api/uploaded-file")
      .query({ path: "src/a.ts" })
      .set("Cookie", cookie);
    expect(read.status).toBe(200);
    expect(read.body.content).toBe("export const a = 1;\n");

    const del = await request(app)
      .post("/api/delete-workspace-file")
      .set("Cookie", cookie)
      .send({ filePath: "src/a.ts" });
    expect(del.status).toBe(200);
    expect(del.body.files).toHaveLength(0);

    const gone = await request(app)
      .get("/api/uploaded-file")
      .query({ path: "src/a.ts" })
      .set("Cookie", cookie);
    expect(gone.status).toBe(404);
  });

  it("overwrites on repeated save (upsert)", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    await request(app).post("/api/save-workspace-file").set("Cookie", cookie)
      .send({ filePath: "src/v.ts", content: "v1" });
    await request(app).post("/api/save-workspace-file").set("Cookie", cookie)
      .send({ filePath: "src/v.ts", content: "v2" });
    const read = await request(app).get("/api/uploaded-file").query({ path: "src/v.ts" }).set("Cookie", cookie);
    expect(read.body.content).toBe("v2");
    const status = await request(app).get("/api/upload-status").set("Cookie", cookie);
    expect(status.body.files.filter((f: any) => f.path === "src/v.ts")).toHaveLength(1);
  });

  it("clear-upload empties the workspace", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    await request(app).post("/api/save-workspace-file").set("Cookie", cookie)
      .send({ filePath: "src/a.ts", content: "x" });
    const clear = await request(app).post("/api/clear-upload").set("Cookie", cookie);
    expect(clear.status).toBe(200);
    const status = await request(app).get("/api/upload-status").set("Cookie", cookie);
    expect(status.body.uploaded).toBe(false);
    expect(status.body.files).toHaveLength(0);
  });

  it("rejects path traversal with 403", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    for (const bad of ["../evil.ts", "../../etc/passwd", "a/../../evil.ts"]) {
      const save = await request(app).post("/api/save-workspace-file").set("Cookie", cookie)
        .send({ filePath: bad, content: "x" });
      expect(save.status).toBe(403);
      const read = await request(app).get("/api/uploaded-file").query({ path: bad }).set("Cookie", cookie);
      expect(read.status).toBe(403);
    }
    // A leading slash is stripped and treated as a relative path (longstanding
    // behavior, harmless: the store has no filesystem to escape from).
    const abs = await request(app).post("/api/save-workspace-file").set("Cookie", cookie)
      .send({ filePath: "/abs.ts", content: "x" });
    expect(abs.status).toBe(200);
    expect(abs.body.filePath).toBe("abs.ts");
  });

  it("isolates workspaces per user", async () => {
    const app = buildApp();
    const cookieA = await authedCookie(app);
    const cookieB = await authedCookie(app);
    await request(app).post("/api/save-workspace-file").set("Cookie", cookieA)
      .send({ filePath: "src/secret.ts", content: "a-secret" });

    const statusB = await request(app).get("/api/upload-status").set("Cookie", cookieB);
    expect(statusB.body.uploaded).toBe(false);

    const readB = await request(app).get("/api/uploaded-file").query({ path: "src/secret.ts" }).set("Cookie", cookieB);
    expect(readB.status).toBe(404);

    // And B clearing their workspace does not touch A's files.
    await request(app).post("/api/clear-upload").set("Cookie", cookieB);
    const readA = await request(app).get("/api/uploaded-file").query({ path: "src/secret.ts" }).set("Cookie", cookieA);
    expect(readA.status).toBe(200);
  });
});

describe("ZIP upload into the store", () => {
  it("ingests entries and replaces the previous workspace atomically", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    await request(app).post("/api/save-workspace-file").set("Cookie", cookie)
      .send({ filePath: "src/old.ts", content: "old" });

    const zipB64 = makeZip({
      "src/new.ts": "export const n = 1;\n",
      "src/nested/deep.ts": "export const d = 2;\n",
      "node_modules/junk.ts": "should be skipped",
      "README.md": "# docs\n",
    });
    const up = await request(app).post("/api/upload-zip").set("Cookie", cookie).send({ zipBase64: zipB64 });
    expect(up.status).toBe(200);
    const paths = up.body.files.map((f: any) => f.path).sort();
    expect(paths).toEqual(["README.md", "src/nested/deep.ts", "src/new.ts"]);

    // The old file is gone: replacement, not merge.
    const readOld = await request(app).get("/api/uploaded-file").query({ path: "src/old.ts" }).set("Cookie", cookie);
    expect(readOld.status).toBe(404);

    const readNew = await request(app).get("/api/uploaded-file").query({ path: "src/new.ts" }).set("Cookie", cookie);
    expect(readNew.body.content).toBe("export const n = 1;\n");
  });

  it("download-workspace zips exactly what is stored", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    await request(app).post("/api/save-workspace-file").set("Cookie", cookie)
      .send({ filePath: "src/a.ts", content: "aaa" });

    const res = await request(app)
      .get("/api/download-workspace")
      .set("Cookie", cookie)
      .buffer(true)
      .parse((res2: any, cb: any) => {
        const chunks: Buffer[] = [];
        res2.on("data", (c: Buffer) => chunks.push(c));
        res2.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const zip = new AdmZip(res.body as Buffer);
    expect(zip.getEntries().map((e) => e.entryName)).toEqual(["src/a.ts"]);
    expect(zip.readAsText("src/a.ts")).toBe("aaa");
  });

  it("download-workspace 404s when empty", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/download-workspace").set("Cookie", await authedCookie(app));
    expect(res.status).toBe(404);
  });
});
