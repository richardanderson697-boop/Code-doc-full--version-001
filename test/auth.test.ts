// Auth routes over HTTP: signup, login, me, logout, and validation.
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import authRouter from "../server/routes/auth";
import { initAuthStore } from "../server/authdb";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  return app;
}

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  initAuthStore();
  app = buildApp();
});

function cookieOf(res: any): string {
  const setCookie: string[] = res.headers["set-cookie"] ?? [];
  const session = setCookie.find((c) => c.startsWith("codedoc_session="));
  expect(session).toBeTruthy();
  return session!.split(";")[0];
}

describe("auth", () => {
  it("signs up with welcome credits and a session cookie", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "Ada@Example.com", password: "supersecret1" });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("ada@example.com"); // normalized
    expect(res.body.user.credits).toBe(Number(process.env.WELCOME_CREDITS ?? 50)); // server default
    expect(cookieOf(res)).toMatch(/^codedoc_session=/);
  });

  it("rejects duplicate emails", async () => {
    await request(app).post("/api/auth/signup").send({ email: "dupe@x.io", password: "supersecret1" });
    const res = await request(app).post("/api/auth/signup").send({ email: "dupe@x.io", password: "supersecret1" });
    expect(res.status).toBe(409);
  });

  it("validates email and password", async () => {
    const badEmail = await request(app).post("/api/auth/signup").send({ email: "not-an-email", password: "supersecret1" });
    expect(badEmail.status).toBe(400);
    const shortPw = await request(app).post("/api/auth/signup").send({ email: "ok@x.io", password: "short" });
    expect(shortPw.status).toBe(400);
  });

  it("logs in, serves me, and logs out", async () => {
    await request(app).post("/api/auth/signup").send({ email: "login@x.io", password: "supersecret1" });
    const login = await request(app).post("/api/auth/login").send({ email: "login@x.io", password: "supersecret1" });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("login@x.io");

    const logout = await request(app).post("/api/auth/logout").set("Cookie", cookie);
    expect(logout.status).toBe(200);
    const meAfter = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(meAfter.status).toBe(401);
  });

  it("rejects wrong passwords without saying whether the email exists", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "nobody@x.io", password: "whatever123" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Incorrect email or password.");
  });

  it("me without a cookie is 401", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("AUTH_REQUIRED");
  });
});
