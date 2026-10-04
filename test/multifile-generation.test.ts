// Tests for multi-file project generation: the manifest planner endpoint
// and the upgraded per-file generation endpoint (context injection +
// refinement). Gemini is mocked; every assertion is about validation,
// file selection, and disk effects — never model output quality.
import { describe, it, expect, beforeAll, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import AdmZip from "adm-zip";

import authRouter from "../server/routes/auth";
import aiRouter from "../server/routes/ai";
import workspaceRouter from "../server/routes/workspace";
import { initStore } from "../server/store";

const mockGenerate = vi.fn();

vi.mock("../server/gemini", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/gemini")>();
  return {
    ...original,
    generateWithFallback: (...args: any[]) => mockGenerate(...args),
  };
});

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authRouter);
  app.use(aiRouter);
  app.use(workspaceRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status || 500).json({ error: err?.message || "server error" });
  });
  return app;
}

function mockManifestResponse(files: { path: string; purpose: string }[], entry = "src/App.tsx") {
  mockGenerate.mockResolvedValue({
    response: {
      text: JSON.stringify({ entry, files }),
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 200 },
    },
    modelName: "test-model",
  });
}

beforeAll(async () => {
  await initStore();
});

beforeEach(() => {
  mockGenerate.mockReset();
});

let cookieCounter = 0;
async function authedCookie(app: any): Promise<string> {
  cookieCounter += 1;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `multifile-test-${cookieCounter}@x.io`, password: "supersecret1" });
  expect(res.status).toBe(201);
  const raw = res.headers["set-cookie"];
  const setCookie: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = setCookie.find((c) => c.startsWith("codedoc_session="));
  expect(session).toBeTruthy();
  return session!.split(";")[0];
}

async function readWorkspaceFile(app: any, cookie: string, relPath: string): Promise<string> {
  // Workspace files live in the DB now, not on disk: read them back through
  // the same API the client uses.
  const res = await request(app)
    .get("/api/uploaded-file")
    .query({ path: relPath })
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.content as string;
}

describe("POST /api/generate-manifest", () => {
  it("400s without a prompt", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/generate-manifest")
      .set("Cookie", await authedCookie(app))
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns a validated manifest with the entry point last", async () => {
    const app = buildApp();
    mockManifestResponse([
      { path: "src/App.tsx", purpose: "Entry" },
      { path: "src/components/Header.tsx", purpose: "Nav" },
    ]);
    const res = await request(app)
      .post("/api/generate-manifest")
      .set("Cookie", await authedCookie(app))
      .send({ prompt: "a todo app" });
    expect(res.status).toBe(200);
    expect(res.body.entry).toBe("src/App.tsx");
    const paths = res.body.files.map((f: any) => f.path);
    expect(paths).toContain("src/App.tsx");
    expect(paths).toContain("src/components/Header.tsx");
    expect(paths[paths.length - 1]).toBe("src/App.tsx");
  });

  it("502s on non-JSON planner output", async () => {
    const app = buildApp();
    mockGenerate.mockResolvedValue({
      response: { text: "here is your plan, good luck", usageMetadata: {} },
      modelName: "test-model",
    });
    const res = await request(app)
      .post("/api/generate-manifest")
      .set("Cookie", await authedCookie(app))
      .send({ prompt: "a todo app" });
    expect(res.status).toBe(502);
  });

  it("502s when the planner omits the entry point", async () => {
    const app = buildApp();
    mockManifestResponse([{ path: "src/components/Header.tsx", purpose: "Nav" }]);
    const res = await request(app)
      .post("/api/generate-manifest")
      .set("Cookie", await authedCookie(app))
      .send({ prompt: "a todo app" });
    expect(res.status).toBe(502);
  });

  it("502s on an invalid planner path", async () => {
    const app = buildApp();
    mockManifestResponse([
      { path: "src/App.tsx", purpose: "Entry" },
      { path: "../../evil.ts", purpose: "Nope" },
    ]);
    const res = await request(app)
      .post("/api/generate-manifest")
      .set("Cookie", await authedCookie(app))
      .send({ prompt: "a todo app" });
    expect(res.status).toBe(502);
  });

  it("502s when the planner exceeds the file cap", async () => {
    const app = buildApp();
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `src/components/F${i}.tsx`,
      purpose: "filler",
    }));
    files.push({ path: "src/App.tsx", purpose: "Entry" });
    mockManifestResponse(files);
    const res = await request(app)
      .post("/api/generate-manifest")
      .set("Cookie", await authedCookie(app))
      .send({ prompt: "a todo app" });
    expect(res.status).toBe(502);
  });
});

describe("GET /api/download-workspace", () => {
  it("404s when the workspace is empty", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/download-workspace")
      .set("Cookie", await authedCookie(app));
    expect(res.status).toBe(404);
  });

  it("streams a ZIP containing the workspace files", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    mockGenerate.mockResolvedValue({
      response: {
        text: "====CODE====\nexport const v = 1;\n====PURPOSE====\ntest",
        usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 400 },
      },
      modelName: "test-model",
    });
    await request(app)
      .post("/api/generate-workspace-file")
      .set("Cookie", cookie)
      .send({ filePath: "src/app.ts", prompt: "an app" });

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
    expect(res.headers["content-type"]).toContain("application/zip");
    const zip = new AdmZip(res.body as Buffer);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("src/app.ts");
    expect(zip.readAsText("src/app.ts")).toContain("export const v = 1;");
  });
});

describe("POST /api/generate-workspace-file upgrades", () => {
  function mockCodeResponse(code: string) {
    mockGenerate.mockResolvedValue({
      response: {
        text: `====CODE====\n${code}\n====PURPOSE====\ntest file`,
        usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 400 },
      },
      modelName: "test-model",
    });
  }

  it("400s without filePath/prompt", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/generate-workspace-file")
      .set("Cookie", await authedCookie(app))
      .send({ filePath: "src/a.ts" });
    expect(res.status).toBe(400);
  });

  it("403s on a traversal path", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/generate-workspace-file")
      .set("Cookie", await authedCookie(app))
      .send({ filePath: "../../evil.ts", prompt: "x" });
    expect(res.status).toBe(403);
  });

  it("writes the generated file into the user's workspace", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    mockCodeResponse("export const greeting = 'hi';");
    const res = await request(app)
      .post("/api/generate-workspace-file")
      .set("Cookie", cookie)
      .send({ filePath: "src/components/Header.tsx", prompt: "a header" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const written = await readWorkspaceFile(app, cookie, "src/components/Header.tsx");
    expect(written).toContain("export const greeting");
  });

  it("accepts existingCode for refinement and overwrites", async () => {
    const app = buildApp();
    const cookie = await authedCookie(app);
    mockCodeResponse("export const v = 1;");
    await request(app)
      .post("/api/generate-workspace-file")
      .set("Cookie", cookie)
      .send({ filePath: "src/lib.ts", prompt: "a lib" });
    mockCodeResponse("export const v = 2;");
    const res = await request(app)
      .post("/api/generate-workspace-file")
      .set("Cookie", cookie)
      .send({ filePath: "src/lib.ts", prompt: "bump it", existingCode: "export const v = 1;" });
    expect(res.status).toBe(200);
    const written = await readWorkspaceFile(app, cookie, "src/lib.ts");
    expect(written).toContain("export const v = 2;");
  });
});
