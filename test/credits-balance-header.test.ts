// The credit badge used to go stale until logout/login. Metered JSON routes
// now stamp the post-charge balance in the X-Credits-Balance header (streams
// get a final SSE event instead) so the client updates the badge live.
import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../server/gemini", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/gemini")>();
  return {
    ...original,
    generateWithFallback: vi.fn(async () => ({
      response: {
        text: JSON.stringify({ findings: [], evidence: [] }),
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
      },
      modelName: "test-model",
    })),
  };
});

import authRouter from "../server/routes/auth";
import coldAuditRouter from "../server/routes/cold-audit";
import { initAuthStore } from "../server/authdb";

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authRouter);
  app.use(coldAuditRouter);
  return app;
}

beforeAll(() => {
  initAuthStore();
});

describe("live credit balance", () => {
  it("stamps X-Credits-Balance with the post-charge balance on a metered JSON response", async () => {
    const app = buildApp();
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: "balance-header@x.io", password: "supersecret1" });
    expect(signup.status).toBe(201);
    const raw = signup.headers["set-cookie"] as unknown as string[];
    const cookie = (Array.isArray(raw) ? raw : [raw])[0].split(";")[0];

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    const startBalance: number = me.body.user.credits;

    const res = await request(app)
      .post("/api/cold-audit")
      .set("Cookie", cookie)
      .send({ code: "const a = 1;\n" });
    expect(res.status).toBe(200);
    // 1000 input + 500 output tokens at the default rates meters to 1 credit.
    expect(res.headers["x-credits-balance"]).toBe(String(startBalance - 1));

    const after = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(after.body.user.credits).toBe(startBalance - 1);
  });

  it("omits the header when no charge was recorded (402 gate)", async () => {
    const app = buildApp();
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: "balance-header-broke@x.io", password: "supersecret1" });
    const raw = signup.headers["set-cookie"] as unknown as string[];
    const cookie = (Array.isArray(raw) ? raw : [raw])[0].split(";")[0];

    const { spendCredits } = await import("../server/credits");
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    spendCredits(me.body.user.id, me.body.user.credits, "test drain");

    const res = await request(app)
      .post("/api/cold-audit")
      .set("Cookie", cookie)
      .send({ code: "const a = 1;\n" });
    expect(res.status).toBe(402);
    expect(res.headers["x-credits-balance"]).toBeUndefined();
  });
});
