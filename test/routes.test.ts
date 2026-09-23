// Route-level tests. The unit tests cover the adapter and the guards in
// isolation, which leaves the WIRING untested: strip asyncRoute off every
// handler, or move the auth gate back behind the body parsers, and every unit
// test still passes. These exercise the assembled app over HTTP.
//
// The app is built here rather than imported from server.ts, because that
// module starts a listener and a Vite dev server on import. The middleware
// order below mirrors it exactly; the order-sensitivity test asserts that.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import request from "supertest";
import AdmZip from "adm-zip";

import { asyncRoute } from "../server/async-route";
import { MAX_ARCHIVE_BYTES } from "../server/routes/workspace";
import projectsRouter from "../server/routes/projects";
import authRouter from "../server/routes/auth";
import coldAuditRouter from "../server/routes/cold-audit";
import workspaceRouter from "../server/routes/workspace";
import { initProjectsStore } from "../server/db";
import { initAuthStore } from "../server/authdb";
import { uploadedDir } from "../server/workspace";

const UPLOADED = uploadedDir();

// Mirrors server.ts: auth gate first, then body parsers, then routes, then the
// error middleware, then the /api 404.
function buildApp(token = "") {
  const app = express();
  app.use("/api", (req, res, next) => {
    if (!token) return next();
    const supplied = Buffer.from(String(req.headers.authorization || ""));
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) {
      return next();
    }
    return res.status(401).json({ error: "Unauthorized: missing or invalid access token" });
  });
  const jsonDefault = express.json({ limit: "10mb" });
  const jsonZipUpload = express.json({ limit: "100mb" });
  app.use((req, res, next) =>
    req.path === "/api/upload-zip" ? jsonZipUpload(req, res, next) : jsonDefault(req, res, next)
  );
  app.use(authRouter);
  app.use(projectsRouter);
  app.use(coldAuditRouter);
  app.use(workspaceRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err?.status === 413 || err?.type === "entity.too.large") {
      return res.status(413).json({ error: "too large" });
    }
    res.status(err?.status || 500).json({ error: err?.message || "server error" });
  });
  app.all("/api/*", (req, res) => res.status(404).json({ error: "not found" }));
  return app;
}

// The payload that used to exit the process: a file that is both a parseable
// repo config with a malformed rule AND trips a probe, so the engine's
// suppression matcher actually runs and throws.
const CRASH_PAYLOAD = JSON.stringify({
  schema: "preflight/v1",
  note: "sk-proj-abcdef1234567890abcdef1234567890abcdef12",
  suppress: [{ probe: "Secret Scanner", "title-pattern": 1 }],
});

beforeAll(() => {
  initProjectsStore();
  initAuthStore();
});

// /api/cold-audit now requires a signed-in user with enough credits.
// Signs up a fresh user (25 welcome credits) and returns its session cookie.
let cookieCounter = 0;
async function authedCookie(app: any): Promise<string> {
  cookieCounter += 1;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `route-test-${cookieCounter}@x.io`, password: "supersecret1" });
  expect(res.status).toBe(201);
  const raw = res.headers["set-cookie"];
  const setCookie: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = setCookie.find((c) => c.startsWith("codedoc_session="));
  expect(session).toBeTruthy();
  return session!.split(";")[0];
}

afterAll(() => {
  fs.rmSync(UPLOADED, { recursive: true, force: true });
});

describe("async handler containment", () => {
  it("answers with 500 instead of dying when the scan layer throws", async () => {
    // Without asyncRoute this rejection is unhandled and Node terminates the
    // process, so the assertion is really "the test run survived this".
    const app = buildApp();
    const res = await request(app)
      .post("/api/cold-audit")
      .set("Cookie", await authedCookie(app))
      .send({ fileName: ".preflight.json", code: CRASH_PAYLOAD });
    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
  });

  it("keeps serving other routes after the crash payload", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/cold-audit")
      .set("Cookie", await authedCookie(app))
      .send({ fileName: ".preflight.json", code: CRASH_PAYLOAD });
    const after = await request(app).get("/api/upload-status");
    expect(after.status).toBe(200);
  });

  it("routes a rejection from any wrapped handler to the error middleware", async () => {
    const app = express();
    app.use(express.json());
    app.get(
      "/api/boom",
      asyncRoute(async () => {
        throw new Error("boom");
      })
    );
    app.use((err: any, _req: any, res: any, _next: any) =>
      res.status(500).json({ error: err.message })
    );
    const res = await request(app).get("/api/boom");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("boom");
  });
});

describe("auth gate ordering", () => {
  const TOKEN = "test-token-abcdefghijklmnop";

  it("rejects an unauthenticated request", async () => {
    const res = await request(buildApp(TOKEN)).get("/api/upload-status");
    expect(res.status).toBe(401);
  });

  it("accepts the correct token", async () => {
    const res = await request(buildApp(TOKEN))
      .get("/api/upload-status")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("rejects a wrong token, wrong scheme, and a prefix of the token", async () => {
    const app = buildApp(TOKEN);
    for (const header of [`Bearer wrong-token-abcdefghij`, `Token ${TOKEN}`, TOKEN, `Bearer ${TOKEN.slice(0, 8)}`]) {
      const res = await request(app).get("/api/upload-status").set("Authorization", header);
      expect(res.status).toBe(401);
    }
  });

  it("rejects before the body parser runs", async () => {
    // Ordering test that does not depend on payload size. Malformed JSON makes
    // express.json respond 400; the auth gate responds 401. Whichever ran
    // first answers. Behind the parsers this returned 400, which meant an
    // anonymous request had already been buffered and parsed before its 401.
    const res = await request(buildApp(TOKEN))
      .post("/api/cold-audit")
      .set("Content-Type", "application/json")
      .send("{ this is not valid json");
    expect(res.status).toBe(401);
  });

  it("does not buffer an anonymous oversize body", async () => {
    // The same property from the caller's side: a body far over the 10mb limit
    // must never come back 413, because that would mean the parser consumed it
    // before the gate. A connection reset counts as a pass here: the server
    // answered and hung up without reading the upload.
    const huge = "a".repeat(11 * 1024 * 1024);
    let status: number | "reset" = 0;
    try {
      const res = await request(buildApp(TOKEN))
        .post("/api/cold-audit")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ code: huge }));
      status = res.status;
    } catch (e: any) {
      if (e?.code === "ECONNRESET" || /ECONNRESET|EPIPE/.test(String(e?.message))) status = "reset";
      else throw e;
    }
    expect(status === 401 || status === "reset").toBe(true);
    expect(status).not.toBe(413);
  });

  it("is off by default so the unauthenticated flow is unchanged", async () => {
    const res = await request(buildApp()).get("/api/upload-status");
    expect(res.status).toBe(200);
  });
});

describe("body size limits", () => {
  it("rejects an oversize body on a normal route", async () => {
    const huge = "a".repeat(11 * 1024 * 1024);
    const res = await request(buildApp())
      .post("/api/cold-audit")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ code: huge }));
    expect(res.status).toBe(413);
  });
});

describe("ZIP intake", () => {
  function directoryOnlyZip(declared: number): Buffer {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(declared & 0xffff, 8);
    eocd.writeUInt16LE(declared & 0xffff, 10);
    return eocd;
  }

  it("rejects an archive declaring more entries than the limit, quickly", async () => {
    const started = Date.now();
    const res = await request(buildApp())
      .post("/api/upload-zip")
      .send({ zipBase64: directoryOnlyZip(60000).toString("base64") });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/entries/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects a non-ZIP payload", async () => {
    const res = await request(buildApp()).post("/api/upload-zip").send({ zipBase64: "AAAA" });
    expect(res.status).toBe(400);
  });

  it("rejects an archive over the size cap, on the encoded length", async () => {
    // Rejected from the base64 length, before the decode allocates.
    const oversize = "A".repeat(Math.ceil(((MAX_ARCHIVE_BYTES + 1024 * 1024) * 4) / 3));
    const res = await request(buildApp()).post("/api/upload-zip").send({ zipBase64: oversize });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("rejects an archive containing a traversal entry name", async () => {
    // adm-zip sanitizes names on write, so a traversal entry cannot be built
    // with addFile. Patch the central directory in place instead, which is
    // where getEntries reads names from, keeping the length identical so every
    // offset stays valid. This is what an archive from other tooling looks like.
    const zip = new AdmZip();
    zip.addFile("src/ok.ts", Buffer.from("export const a = 1;\n"));
    const buf = zip.toBuffer();

    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const nameAt = cdOffset + 46;
    const evil = "../evil.t"; // same 9 bytes as "src/ok.ts"
    expect(evil.length).toBe(nameLen);
    Buffer.from(evil).copy(buf, nameAt);

    const parsed = new AdmZip(buf);
    expect(parsed.getEntries()[0].entryName).toBe(evil);

    const res = await request(buildApp())
      .post("/api/upload-zip")
      .send({ zipBase64: buf.toString("base64") });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsafe file paths/i);
  });

  it("accepts a well-formed archive", async () => {
    const zip = new AdmZip();
    zip.addFile("src/index.ts", Buffer.from("export const a = 1;\n"));
    const res = await request(buildApp())
      .post("/api/upload-zip")
      .send({ zipBase64: zip.toBuffer().toString("base64") });
    expect(res.status).toBe(200);
    expect(res.body.files.some((f: any) => f.path === "src/index.ts")).toBe(true);
  });

  it("leaves an existing workspace intact when the upload is rejected", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/save-workspace-file")
      .send({ filePath: "keepme.ts", content: "export const keep = 1;\n" });

    await request(app).post("/api/upload-zip").send({ zipBase64: "AAAA" });

    const status = await request(app).get("/api/upload-status");
    expect(status.body.files.some((f: any) => f.path === "keepme.ts")).toBe(true);
  });
});

describe("workspace path containment over HTTP", () => {
  it("refuses traversal on write, delete, and read", async () => {
    const app = buildApp();
    const write = await request(app)
      .post("/api/save-workspace-file")
      .send({ filePath: "../../escaped.txt", content: "x" });
    expect(write.status).toBe(403);

    const del = await request(app)
      .post("/api/delete-workspace-file")
      .send({ filePath: "../../../etc/passwd" });
    expect(del.status).toBe(403);

    const read = await request(app)
      .get("/api/uploaded-file")
      .query({ path: "../../package.json" });
    expect(read.status).toBe(403);
  });

  it("refuses a prefix-sibling directory, the original bypass", async () => {
    const res = await request(buildApp())
      .post("/api/save-workspace-file")
      .send({ filePath: "../uploaded_project-evil/steal.txt", content: "x" });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(process.cwd(), "uploaded_project-evil"))).toBe(false);
  });
});

describe("cold-audit degraded response", () => {
  it("carries the deterministic report on the error path", async () => {
    // No API key in the test environment, so the AI pass fails. The client
    // renders findings from this, so the field has to be present.
    const app = buildApp();
    const res = await request(app)
      .post("/api/cold-audit")
      .set("Cookie", await authedCookie(app))
      .send({ code: 'const K = "sk-proj-abcdef1234567890abcdef1234567890abcdef12";\n' });
    expect(res.status).toBe(500);
    expect(res.body.preflight).toBeDefined();
    expect(res.body.preflight.findings.length).toBeGreaterThan(0);
  });

  it("rejects a missing or empty code field", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    expect((await request(app).post("/api/cold-audit").set("Cookie", cookie).send({})).status).toBe(400);
    expect((await request(app).post("/api/cold-audit").set("Cookie", cookie).send({ code: "   " })).status).toBe(400);
  });

  it("rejects anonymous callers with 401", async () => {
    const res = await request(buildApp()).post("/api/cold-audit").send({ code: "const a = 1;\n" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("AUTH_REQUIRED");
  });

  it("rejects broke users with 402", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    // Drain the 25 welcome credits below the 15-credit minimum.
    const { spendCredits } = await import("../server/credits");
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    spendCredits(me.body.user.id, 25, "test drain");
    const res = await request(app).post("/api/cold-audit").set("Cookie", cookie).send({ code: "const a = 1;\n" });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
  });
});
