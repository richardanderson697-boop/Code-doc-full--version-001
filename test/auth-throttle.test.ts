// Auth throttles (finalread-self-scan-fixes-spec.md Part B): signup, login,
// and reset-password are throttled per email and per IP with the approved
// limits (signup 5/email + 10/IP, login 10/email + 30/IP, reset 30/IP per
// hour), returning the same 429 shape as forgot-password. The global setup
// resets the throttle map before each test, so these tests start fresh and
// prove the limits within a single test.
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import authRouter from "../server/routes/auth";
import { initStore } from "../server/store";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  return app;
}

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await initStore();
  app = buildApp();
});

describe("auth throttles", () => {
  it("signup: the 6th attempt for one email is 429 (5/email/hour)", async () => {
    const email = "throttle-email@x.io";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post("/api/auth/signup")
        .send({ email, password: "supersecret1" });
      statuses.push(res.status);
    }
    // The first attempt creates the account (201); attempts 2-5 hit the
    // duplicate-email 409 — all five count toward the throttle, which is
    // checked before the database lookup.
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
  });

  it("signup: the 11th signup from one IP is 429 (10/IP/hour)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post("/api/auth/signup")
        .send({ email: `throttle-ip-${i}@x.io`, password: "supersecret1" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  it("login: the 11th login for one email is 429 (10/email/hour)", async () => {
    const email = "throttle-login@x.io";
    const created = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "supersecret1" });
    expect(created.status).toBe(201);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email, password: "supersecret1" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });

  it("reset-password: the 31st attempt from one IP is 429 (30/IP/hour)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: "not-a-real-token", password: "supersecret1" });
      statuses.push(res.status);
    }
    // The first 30 hit the invalid-token 400; the throttle is checked
    // before the token lookup, so the 31st is 429.
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(400));
    expect(statuses[30]).toBe(429);
  });
});
