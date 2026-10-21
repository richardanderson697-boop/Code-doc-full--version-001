// Degraded-path contract for /api/project-intelligence: the route computes
// the deterministic PreFlight scan BEFORE the model call, so when the model
// fails (e.g. a provider outage returning 429), the error response must
// still carry the PreFlight report — the client renders those findings
// under the failure banner instead of showing a bare error. This mirrors
// the contract the audit routes already honor (errData.preflight).
import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../server/gemini", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/gemini")>();
  return {
    ...original,
    generateWithFallback: vi.fn(async () => {
      throw new Error("429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'generate-content' (spend cap reached)");
    }),
  };
});

import authRouter from "../server/routes/auth";
import intelligenceRouter from "../server/routes/intelligence";
import { initStore } from "../server/store";

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

let cookieCounter = 0;
async function authedCookie(app: any): Promise<string> {
  cookieCounter += 1;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `intel-degraded-test-${cookieCounter}@x.io`, password: "supersecret1" });
  expect(res.status).toBe(201);
  const raw = res.headers["set-cookie"];
  const setCookie: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = setCookie.find((c) => c.startsWith("codedoc_session="));
  expect(session).toBeTruthy();
  return session!.split(";")[0];
}

// Same flagged corpus the PreFlight suite uses: hardcoded key + eval sink.
const VULNERABLE = `import express from 'express';
const app = express();
const API_KEY = 'sk-live-FAKEKEYFORTESTS0123456789abcdef';
app.get('/run', (req, res) => {
  const cmd = req.query.cmd;
  eval(cmd);
  res.send('<h1>' + req.query.name + '</h1>');
});
app.listen(3000);
`;

const CLEAN = `export function add(a: number, b: number): number {
  return a + b;
}
`;

describe("project-intelligence degraded PreFlight", () => {
  it("model failure still returns the deterministic findings with the error", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", await authedCookie(app))
      .send({ codeFiles: [{ path: "server.js", content: VULNERABLE }] });
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
    // The degraded contract: preflight rides along with the error.
    expect(res.body.preflight).toBeTruthy();
    expect(Array.isArray(res.body.preflight.findings)).toBe(true);
    expect(res.body.preflight.findings.length).toBeGreaterThan(0);
    expect(
      res.body.preflight.findings.some((f: any) => f.path === "server.js" || f.file === "server.js" || JSON.stringify(f).includes("server.js"))
    ).toBe(true);
  });

  it("model failure with a clean scan still returns a (zero-finding) report", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", await authedCookie(app))
      .send({ codeFiles: [{ path: "math.ts", content: CLEAN }] });
    expect(res.status).toBe(500);
    expect(res.body.preflight).toBeTruthy();
    expect(Array.isArray(res.body.preflight.findings)).toBe(true);
    expect(res.body.preflight.findings.length).toBe(0);
  });
});
