// Regression test for the healer failure the user hit: when the model returns
// an empty response, /api/heal must NOT return HTTP 200 with an empty string
// (which the client surfaced as "No healed code was returned from server").
// It must return an error with a clear message and must NOT charge credits.
import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";

// formatGeminiError short-circuits to "key not set" when there is no real key;
// a dummy keeps the route's own error messages intact for assertions.
process.env.GEMINI_API_KEY = "test-key";

// Controllable mock so each test decides what the model returns.
let nextText = "";
let nextFinishReason: string | undefined = undefined;
vi.mock("../server/gemini", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/gemini")>();
  return {
    ...original,
    generateWithFallback: vi.fn(async () => ({
      response: {
        text: nextText,
        candidates: nextFinishReason ? [{ finishReason: nextFinishReason }] : [],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
      },
      modelName: "test-model",
    })),
  };
});

import authRouter from "../server/routes/auth";
import aiRouter from "../server/routes/ai";
import { initStore } from "../server/store";

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authRouter);
  app.use(aiRouter);
  return app;
}

beforeAll(async () => {
  await initStore();
});

async function authedCookie(app: any, tag: string): Promise<{ cookie: string; startBalance: number }> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: `${tag}@x.io`, password: "supersecret1" });
  expect(signup.status).toBe(201);
  const raw = signup.headers["set-cookie"] as unknown as string[];
  const cookie = (Array.isArray(raw) ? raw : [raw])[0].split(";")[0];
  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
  return { cookie, startBalance: me.body.user.credits };
}

async function balanceOf(app: any, cookie: string): Promise<number> {
  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
  return me.body.user.credits;
}

describe("heal empty model response", () => {
  it("returns an error (not 200 + empty healedCode) and charges nothing", async () => {
    const app = buildApp();
    const { cookie, startBalance } = await authedCookie(app, "heal-empty");
    nextText = "";
    nextFinishReason = undefined;

    const res = await request(app)
      .post("/api/heal")
      .set("Cookie", cookie)
      .send({ code: "export default function App() {\n  return <div>hi</div>;\n" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/empty response/i);
    expect(res.body.error).toMatch(/no credits were charged/i);
    expect(await balanceOf(app, cookie)).toBe(startBalance);
  });

  it("explains a SAFETY block and charges nothing", async () => {
    const app = buildApp();
    const { cookie, startBalance } = await authedCookie(app, "heal-safety");
    nextText = "";
    nextFinishReason = "SAFETY";

    const res = await request(app)
      .post("/api/heal")
      .set("Cookie", cookie)
      .send({ code: "const a = 1;\n" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/safety filters/i);
    expect(await balanceOf(app, cookie)).toBe(startBalance);
  });

  it("still succeeds and charges when the model returns code", async () => {
    const app = buildApp();
    const { cookie, startBalance } = await authedCookie(app, "heal-ok");
    nextText = "```tsx\nexport default function App() {\n  return <div>healed</div>;\n}\n```";
    nextFinishReason = undefined;

    const res = await request(app)
      .post("/api/heal")
      .set("Cookie", cookie)
      .send({ code: "export default function App() {\n" });

    expect(res.status).toBe(200);
    expect(res.body.healedCode).toContain("export default function App()");
    expect(res.body.healedCode).not.toContain("```");
    expect(await balanceOf(app, cookie)).toBeLessThan(startBalance);
  });
});
