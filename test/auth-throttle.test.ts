// Auth throttles (finalread-self-scan-fixes-spec.md Part B): signup, login,
// and reset-password are throttled per email and per IP with the approved
// limits (signup 5/email + 10/IP, login 10/email + 30/IP, reset 30/IP per
// hour), returning the same 429 shape as forgot-password. The global setup
// resets the throttle map before each test, so these tests start fresh and
// prove the limits within a single test.
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import authRouter, { clientIp } from "../server/routes/auth";
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

  it("reset-password: rotating the spoofed first XFF value does not defeat the IP limit", async () => {
    // XFF throttle fix (finalread-xff-throttle-fix-spec.md): the throttle
    // keys on the LAST X-Forwarded-For value — the one Railway appends —
    // so requests that rotate a spoofed first value but share the last
    // value land in one bucket. The old code keyed on the first value
    // and would never have throttled these.
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await request(app)
        .post("/api/auth/reset-password")
        .set("X-Forwarded-For", `198.51.100.${i}, 203.0.113.7`)
        .send({ token: "not-a-real-token", password: "supersecret1" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(400));
    expect(statuses[30]).toBe(429);
  });

  it("reset-password: rotating the spoofed first XFF value does not defeat the IP limit behind Cloudflare", async () => {
    // CF fix (finalread-cf-connecting-ip-spec.md): behind Cloudflare the
    // throttle keys on CF-Connecting-IP — trusted only because the last
    // XFF value is a Cloudflare edge IP — so requests that rotate a
    // spoofed first value but share the CF-Connecting-IP land in one
    // bucket.
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await request(app)
        .post("/api/auth/reset-password")
        .set("X-Forwarded-For", `198.51.100.${i}, 173.245.48.1`)
        .set("CF-Connecting-IP", "203.0.113.55")
        .send({ token: "not-a-real-token", password: "supersecret1" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(400));
    expect(statuses[30]).toBe(429);
  });
});

// clientIp unit tests (finalread-xff-throttle-fix-spec.md): the helper
// returns the last X-Forwarded-For value, falling back to req.ip.
// (finalread-cf-connecting-ip-spec.md): CF-Connecting-IP is trusted only
// when the last X-Forwarded-For value falls inside Cloudflare's published
// ranges; otherwise a faked CF-Connecting-IP is ignored.
describe("clientIp", () => {
  it("returns the last X-Forwarded-For value (the trusted proxy's)", () => {
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" },
      ip: "203.0.113.1",
    } as any;
    expect(clientIp(req)).toBe("9.10.11.12");
  });

  it("returns the single value when there is only one", () => {
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4" },
      ip: "203.0.113.1",
    } as any;
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to req.ip with no header", () => {
    const req = { headers: {}, ip: "203.0.113.1" } as any;
    expect(clientIp(req)).toBe("203.0.113.1");
  });

  it("falls back to req.ip with an empty header", () => {
    const req = {
      headers: { "x-forwarded-for": "   " },
      ip: "203.0.113.1",
    } as any;
    expect(clientIp(req)).toBe("203.0.113.1");
  });

  it("falls back to 'unknown' with neither", () => {
    const req = { headers: {} } as any;
    expect(clientIp(req)).toBe("unknown");
  });

  it("returns CF-Connecting-IP when the last XFF value is a Cloudflare IP", () => {
    const req = {
      headers: {
        "x-forwarded-for": "1.2.3.4, 5.6.7.8, 173.245.48.1",
        "cf-connecting-ip": "203.0.113.55",
      },
      ip: "203.0.113.1",
    } as any;
    expect(clientIp(req)).toBe("203.0.113.55");
  });

  it("falls back to the last XFF value when CF-Connecting-IP is empty", () => {
    const req = {
      headers: {
        "x-forwarded-for": "1.2.3.4, 173.245.48.1",
        "cf-connecting-ip": "   ",
      },
      ip: "203.0.113.1",
    } as any;
    expect(clientIp(req)).toBe("173.245.48.1");
  });

  it("ignores a faked CF-Connecting-IP when the last XFF value is not a Cloudflare IP", () => {
    // Key security test (finalread-cf-connecting-ip-spec.md): on the
    // direct Railway path the last XFF value is the visitor's own IP,
    // so a faked CF-Connecting-IP must be ignored. (This fires the
    // rate-limited mismatch log once; expected and harmless.)
    const req = {
      headers: {
        "x-forwarded-for": "1.2.3.4, 203.0.113.1",
        "cf-connecting-ip": "203.0.113.99",
      },
      ip: "203.0.113.1",
    } as any;
    expect(clientIp(req)).toBe("203.0.113.1");
  });

  it("falls back to req.ip when CF-Connecting-IP is set but there is no XFF header", () => {
    // Without a last XFF value there is nothing to check against the
    // ranges, so the CF-Connecting-IP is unverifiable and untrusted.
    const req = {
      headers: { "cf-connecting-ip": "203.0.113.55" },
      ip: "203.0.113.1",
    } as any;
    expect(clientIp(req)).toBe("203.0.113.1");
  });

  it("returns CF-Connecting-IP when the last XFF value is a Cloudflare IPv6 address", () => {
    const req = {
      headers: {
        "x-forwarded-for": "1.2.3.4, 2400:cb00::1",
        "cf-connecting-ip": "203.0.113.55",
      },
      ip: "203.0.113.1",
    } as any;
    expect(clientIp(req)).toBe("203.0.113.55");
  });

  it("ignores a junk CF-Connecting-IP even when the last XFF value is a Cloudflare IP", () => {
    const req = {
      headers: {
        "x-forwarded-for": "1.2.3.4, 173.245.48.1",
        "cf-connecting-ip": "not-an-ip",
      },
      ip: "203.0.113.1",
    } as any;
    expect(clientIp(req)).toBe("173.245.48.1");
  });
});
