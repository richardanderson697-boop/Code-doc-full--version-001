// Password-reset flow: forgot-password (no enumeration) and reset-password
// (token validation, single-use, expiry, session invalidation).
import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import express from "express";
import request from "supertest";
import authRouter from "../server/routes/auth";
import { initStore, getDb } from "../server/store";

function buildApp() {
  const app = express();
  app.use(express.json());
  // Trust proxy headers like the test client sends them.
  app.set("trust proxy", true);
  app.use(authRouter);
  return app;
}

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await initStore();
  app = buildApp();
});

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function insertToken(userId: string, token: string, expiresAt: Date) {
  const db = getDb();
  await db.run(
    "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)",
    [crypto.randomUUID(), userId, hashToken(token), expiresAt.toISOString(), new Date().toISOString()]
  );
}

async function userIdOf(email: string): Promise<string> {
  const row = await getDb().get<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  return row!.id;
}

describe("password reset", () => {
  it("forgot-password returns ok for unknown emails (no enumeration)", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "nobody-here@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("forgot-password rejects malformed emails", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("forgot-password returns ok for known emails even without email configured", async () => {
    await request(app).post("/api/auth/signup").send({ email: "resetme@x.io", password: "oldpassword1" });
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "resetme@x.io" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("reset-password sets a new password and invalidates sessions", async () => {
    await request(app).post("/api/auth/signup").send({ email: "changeme@x.io", password: "oldpassword1" });
    const uid = await userIdOf("changeme@x.io");

    // Log in to get a session, then reset.
    const login = await request(app).post("/api/auth/login").send({ email: "changeme@x.io", password: "oldpassword1" });
    const setCookies = login.headers["set-cookie"] as unknown as string[];
    const cookie = setCookies.find((c) => c.startsWith("codedoc_session="))!.split(";")[0];

    const token = crypto.randomBytes(32).toString("hex");
    await insertToken(uid, token, new Date(Date.now() + 60 * 60 * 1000));

    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: "brandnewpassword1" });
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);

    // Old password no longer works, new one does.
    const oldLogin = await request(app).post("/api/auth/login").send({ email: "changeme@x.io", password: "oldpassword1" });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post("/api/auth/login").send({ email: "changeme@x.io", password: "brandnewpassword1" });
    expect(newLogin.status).toBe(200);

    // Pre-reset session is dead.
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });

  it("reset-password rejects reused tokens (single-use)", async () => {
    await request(app).post("/api/auth/signup").send({ email: "onetime@x.io", password: "oldpassword1" });
    const uid = await userIdOf("onetime@x.io");
    const token = crypto.randomBytes(32).toString("hex");
    await insertToken(uid, token, new Date(Date.now() + 60 * 60 * 1000));

    const first = await request(app).post("/api/auth/reset-password").send({ token, password: "newpassword1" });
    expect(first.status).toBe(200);
    const second = await request(app).post("/api/auth/reset-password").send({ token, password: "anotherpass1" });
    expect(second.status).toBe(400);
  });

  it("reset-password rejects expired and unknown tokens", async () => {
    await request(app).post("/api/auth/signup").send({ email: "expired@x.io", password: "oldpassword1" });
    const uid = await userIdOf("expired@x.io");
    const token = crypto.randomBytes(32).toString("hex");
    await insertToken(uid, token, new Date(Date.now() - 1000)); // already expired

    const expired = await request(app).post("/api/auth/reset-password").send({ token, password: "newpassword1" });
    expect(expired.status).toBe(400);

    const unknown = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: crypto.randomBytes(32).toString("hex"), password: "newpassword1" });
    expect(unknown.status).toBe(400);
  });

  it("reset-password rejects short passwords", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "whatever", password: "short" });
    expect(res.status).toBe(400);
  });
});
