// Regression tests for Step 2 (/api/project-intelligence) source selection.
//
// The route used to fall back to scanning the application's own directory
// (process.cwd()) whenever the user had no upload, silently grading
// GradeVibes' own source (test/, scripts/, ...) as the user's project. It now
// grades exactly what the client names — the uploaded workspace, selected
// paths inside it, or supplied code files — and reports notEnoughFiles
// otherwise. These tests pin that contract without touching Gemini: every
// case below returns before any AI call.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import fs from "fs";
import request from "supertest";

import authRouter from "../server/routes/auth";
import intelligenceRouter from "../server/routes/intelligence";
import { initStore } from "../server/store";
import { uploadedDir } from "../server/workspace";

const UPLOADED = uploadedDir();

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authRouter);
  app.use(intelligenceRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status || 500).json({ error: err?.message || "server error" });
  });
  return app;
}

beforeAll(async () => {
  await initStore();
});

afterAll(() => {
  fs.rmSync(UPLOADED, { recursive: true, force: true });
});

let cookieCounter = 0;
async function authedCookie(app: any): Promise<string> {
  cookieCounter += 1;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `intel-src-test-${cookieCounter}@x.io`, password: "supersecret1" });
  expect(res.status).toBe(201);
  const raw = res.headers["set-cookie"];
  const setCookie: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = setCookie.find((c) => c.startsWith("codedoc_session="));
  expect(session).toBeTruthy();
  return session!.split(";")[0];
}

describe("project-intelligence source selection", () => {
  it("never grades the application's own directory: no upload and no source -> notEnoughFiles", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", await authedCookie(app))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.notEnoughFiles).toBe(true);
    // The old process.cwd() fallback returned a full scored report here,
    // grading the app's own files as the user's project.
    expect(res.body.overallScore).toBeUndefined();
    expect(res.body.intelligence).toBeUndefined();
  });

  it("rejects path traversal in selected paths", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", await authedCookie(app))
      .send({ paths: ["../../server.ts"] });
    expect(res.status).toBe(400);
  });

  it("rejects unknown workspace files", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", await authedCookie(app))
      .send({ paths: ["does-not-exist.ts"] });
    expect(res.status).toBe(400);
  });

  it("rejects malformed codeFiles", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", await authedCookie(app))
      .send({ codeFiles: [{ path: "a.ts" }] });
    expect(res.status).toBe(400);
  });

  it("rejects an over-limit code file", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", await authedCookie(app))
      .send({ codeFiles: [{ path: "a.ts", content: "x".repeat(2 * 1024 * 1024) }] });
    expect(res.status).toBe(400);
  });
});
