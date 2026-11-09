// FinalRead billing: one $199 price, 2 included re-scans (billing spec).
// Copy + audience rules are pure; the webhook grant, entitlement store,
// and the intelligence re-scan flow are exercised against the real
// SQLite store with the Gemini layer mocked (no live Stripe purchase).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

vi.mock("../server/gemini", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/gemini")>();
  return {
    ...original,
    generateWithFallback: vi.fn(async () => ({
      response: {
        text: JSON.stringify(CANNED_INTEL),
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      },
      modelName: "gemini-3.6-flash",
    })),
  };
});

// A minimal valid intelligence response: the handler overwrites every
// score from the deterministic assessment and keeps the reason strings.
const CANNED_INTEL = {
  overallSummary: "A tiny test project.",
  completenessScore: 50,
  categoryScores: {
    serverStarts: { score: 5, max: 10, reason: "Starts." },
    authentication: { score: 5, max: 10, reason: "Auth present." },
    databaseLayer: { score: 5, max: 10, reason: "DB present." },
    errorHandling: { score: 5, max: 10, reason: "Errors handled." },
    coreLogic: { score: 5, max: 10, reason: "Logic present." },
    backgroundAutomation: { score: 5, max: 10, reason: "No automation needed." },
    externalIntegrations: { score: 5, max: 10, reason: "No integrations needed." },
    security: { score: 5, max: 10, reason: "Secure enough." },
    performance: { score: 5, max: 10, reason: "Fast enough." },
    documentationVerified: { score: 5, max: 10, reason: "Documented." },
  },
  fileLedger: [],
  applicationMap: { entrypoint: "server.js", components: [], endpoints: [] },
  missingFeatures: [],
};

import { generateWithFallback } from "../server/gemini";
import authRouter from "../server/routes/auth";
import intelligenceRouter from "../server/routes/intelligence";
import billingRouter, { handleStripeWebhook, getPacks } from "../server/routes/billing";
import { initStore, getDb } from "../server/store";
import {
  FINALREAD_RESCAN_COUNT,
  consumeRescanEntitlement,
  countRemainingEntitlements,
  findUsableEntitlement,
  grantRescanEntitlements,
  hashReviewContent,
} from "../server/finalread-rescans";
import { pricingAudienceFor } from "../src/utils/pricing-audience";
import {
  createEntryReview,
  withIntelResult,
  withIntelStatus,
} from "../src/utils/sharedReview";

const mockedFallback = vi.mocked(generateWithFallback);

const SECRET = "whsec_test_finalread_billing";

function sign(payload: string, secret: string): string {
  const t = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  await initStore();
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
});

let eventCounter = 0;
function webhookEvent(overrides: any = {}) {
  eventCounter += 1;
  return {
    id: `evt_test_finalread_${eventCounter}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        payment_status: "paid",
        client_reference_id: "user-ghost-uuid",
        metadata: { userId: "user-ghost-uuid", credits: "400", packId: "finalread" },
        customer_email: "buyer@example.com",
        ...overrides,
      },
    },
  };
}

function fakeReqRes(payload: any) {
  const body = JSON.stringify(payload);
  const req: any = {
    body: Buffer.from(body),
    headers: { "stripe-signature": sign(body, SECRET) },
  };
  let statusCode = 200;
  let jsonBody: any = null;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(obj: any) {
      jsonBody = obj;
      return res;
    },
  };
  return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
}

let userCounter = 0;
async function signupUser(app: any, emailPrefix = "finalread-billing"): Promise<{ userId: string; cookie: string }> {
  userCounter += 1;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: `${emailPrefix}-${userCounter}@x.io`, password: "supersecret1" });
  expect(res.status).toBe(201);
  const raw = res.headers["set-cookie"];
  const setCookie: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = setCookie.find((c) => c.startsWith("codedoc_session="));
  expect(session).toBeTruthy();
  return { userId: res.body.user.id, cookie: session!.split(";")[0] };
}

async function balanceOf(userId: string): Promise<number> {
  const row = await getDb().get<{ credits_balance: number }>(
    "SELECT credits_balance FROM users WHERE id = $1",
    [userId]
  );
  return row ? row.credits_balance : 0;
}

async function setBalance(userId: string, balance: number): Promise<void> {
  await getDb().run("UPDATE users SET credits_balance = $1 WHERE id = $2", [balance, userId]);
}

async function entitlementsOf(userId: string) {
  return getDb().all<any>("SELECT * FROM finalread_rescan_entitlements WHERE user_id = $1", [
    userId,
  ]);
}

// The entitlement table references users(id): store-level tests seed the
// user row first (route/webhook tests use real signups instead).
async function ensureUser(userId: string): Promise<void> {
  const db = getDb();
  const sql =
    db.dialect === "postgres"
      ? "INSERT INTO users (id, email, password_hash, password_salt, credits_balance, created_at) VALUES ($1, $2, $3, $4, 0, $5) ON CONFLICT (id) DO NOTHING"
      : "INSERT OR IGNORE INTO users (id, email, password_hash, password_salt, credits_balance, created_at) VALUES ($1, $2, $3, $4, 0, $5)";
  await db.run(sql, [userId, `${userId}@x.io`, "x", "y", new Date().toISOString()]);
}

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

const CLEAN = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
const CHANGED = `export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n`;
const CHANGED2 = `export function add(a: number, b: number): number {\n  return a + b + 2;\n}\n`;

describe("FinalRead billing copy + pricing audience", () => {
  it("names the 2 re-scans in the FinalRead pack tagline", () => {
    const pack = getPacks().find((p) => p.id === "finalread")!;
    expect(pack.priceCents).toBe(19900);
    expect(pack.credits).toBe(400);
    expect(pack.tagline).toContain("2 re-scans");
  });

  it("defaults to the FinalRead price on getfinalread.com and the staging host", () => {
    expect(pricingAudienceFor(false, "getfinalread.com")).toBe("finalread");
    expect(
      pricingAudienceFor(false, "accomplished-consideration-production-18ca.up.railway.app")
    ).toBe("finalread");
    expect(pricingAudienceFor(false, "anything-123.up.railway.app")).toBe("finalread");
  });

  it("shows consumer packs on gradevibes.com and localhost", () => {
    expect(pricingAudienceFor(false, "gradevibes.com")).toBeUndefined();
    expect(pricingAudienceFor(false, "localhost")).toBeUndefined();
    expect(pricingAudienceFor(false, "www.gradevibes.com")).toBeUndefined();
  });

  it("shows FinalRead pricing in the entry whatever the host", () => {
    expect(pricingAudienceFor(true, "gradevibes.com")).toBe("finalread");
    expect(pricingAudienceFor(true, "localhost")).toBe("finalread");
  });
});

describe("re-scan entitlement store", () => {
  it("grants 2, expiring 90 days after purchase", async () => {
    await ensureUser("user-a");
    const purchasedAt = new Date("2026-11-09T12:00:00.000Z");
    const row = await grantRescanEntitlements("user-a", "finalread", "evt_store_1", purchasedAt);
    expect(row.remaining).toBe(FINALREAD_RESCAN_COUNT);
    expect(row.expires_at).toBe("2027-02-07T12:00:00.000Z");
    expect(await countRemainingEntitlements("user-a", purchasedAt)).toBe(2);
  });

  it("is idempotent on the Stripe event id", async () => {
    await ensureUser("user-b");
    const purchasedAt = new Date("2026-11-09T12:00:00.000Z");
    await grantRescanEntitlements("user-b", "finalread", "evt_store_2", purchasedAt);
    await grantRescanEntitlements("user-b", "finalread", "evt_store_2", purchasedAt);
    const rows = await getDb().all<any>(
      "SELECT * FROM finalread_rescan_entitlements WHERE stripe_event_id = $1",
      ["evt_store_2"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].remaining).toBe(2);
  });

  it("consumes one at a time and refuses an exhausted grant", async () => {
    await ensureUser("user-c");
    const purchasedAt = new Date("2026-11-09T12:00:00.000Z");
    const row = await grantRescanEntitlements("user-c", "finalread", "evt_store_3", purchasedAt);
    expect(await consumeRescanEntitlement(row.id)).toBe(true);
    expect(await consumeRescanEntitlement(row.id)).toBe(true);
    expect(await consumeRescanEntitlement(row.id)).toBe(false);
    expect(await findUsableEntitlement("user-c", purchasedAt)).toBeUndefined();
    expect(await countRemainingEntitlements("user-c", purchasedAt)).toBe(0);
  });

  it("ignores expired entitlements", async () => {
    await ensureUser("user-d");
    const purchasedAt = new Date("2026-08-01T12:00:00.000Z"); // 100 days before 2026-11-09
    await grantRescanEntitlements("user-d", "finalread", "evt_store_4", purchasedAt);
    expect(await findUsableEntitlement("user-d", new Date("2026-11-09T12:00:00.000Z"))).toBeUndefined();
    expect(await countRemainingEntitlements("user-d", new Date("2026-11-09T12:00:00.000Z"))).toBe(0);
  });

  it("hashes content, not file order", () => {
    const a = [
      { path: "b.js", content: "2" },
      { path: "a.js", content: "1" },
    ];
    const b = [
      { path: "a.js", content: "1" },
      { path: "b.js", content: "2" },
    ];
    expect(hashReviewContent(a)).toBe(hashReviewContent(b));
    expect(hashReviewContent([{ path: "a.js", content: "1" }])).not.toBe(
      hashReviewContent([{ path: "a.js", content: "2" }])
    );
    expect(hashReviewContent([{ path: "a.js", content: "1" }])).not.toBe(
      hashReviewContent([{ path: "b.js", content: "1" }])
    );
  });
});

describe("shared review carries the frozen-version id", () => {
  it("createEntryReview stores it, withIntelResult preserves and replaces it", () => {
    const r = createEntryReview("App", { total: 80 }, "frv_1");
    expect(r.finalreadReviewId).toBe("frv_1");
    expect(withIntelResult(r, { total: 81 }).finalreadReviewId).toBe("frv_1");
    expect(withIntelResult(r, { total: 81 }, "frv_2").finalreadReviewId).toBe("frv_2");
    const plain = createEntryReview("App", { total: 80 });
    expect(plain.finalreadReviewId).toBeUndefined();
    expect(withIntelResult(plain, { total: 81 }).finalreadReviewId).toBeUndefined();
  });

  it("withIntelStatus loading keeps it", () => {
    const r = createEntryReview("App", { total: 80 }, "frv_1");
    expect(withIntelStatus(r, "loading").finalreadReviewId).toBe("frv_1");
  });
});

describe("stripe webhook: $199 grants come from server code", () => {
  it("grants exactly 400 credits + 2 entitlements when metadata credits are tampered", async () => {
    const app = buildApp();
    const { userId } = await signupUser(app);
    const payload = webhookEvent({
      client_reference_id: userId,
      metadata: { userId, credits: "999999", packId: "finalread" },
    });
    const { req, res, getJson } = fakeReqRes(payload);
    await handleStripeWebhook(req, res);
    expect(getJson()).toMatchObject({ received: true });
    expect(getJson().skipped).toBeUndefined();
    expect(await balanceOf(userId)).toBe(50 + 400);
    const rows = await entitlementsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].remaining).toBe(2);
    expect(rows[0].pack_id).toBe("finalread");
  });

  it("grants exactly 400 + 2 when metadata credits are absent", async () => {
    const app = buildApp();
    const { userId } = await signupUser(app);
    const payload = webhookEvent({
      client_reference_id: userId,
      metadata: { userId, packId: "finalread" },
    });
    // ensure the key is truly absent, not JSON null
    const body = JSON.parse(JSON.stringify(payload));
    delete body.data.object.metadata.credits;
    const { req, res, getJson } = fakeReqRes(body);
    await handleStripeWebhook(req, res);
    expect(getJson().skipped).toBeUndefined();
    expect(await balanceOf(userId)).toBe(50 + 400);
    expect((await entitlementsOf(userId)).length).toBe(1);
  });

  it("does not double-grant on webhook retry", async () => {
    const app = buildApp();
    const { userId } = await signupUser(app);
    const payload = webhookEvent({
      client_reference_id: userId,
      metadata: { userId, credits: "400", packId: "finalread" },
    });
    const first = fakeReqRes(payload);
    await handleStripeWebhook(first.req, first.res);
    const second = fakeReqRes(payload);
    await handleStripeWebhook(second.req, second.res);
    expect(await balanceOf(userId)).toBe(50 + 400);
    const rows = await entitlementsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].remaining).toBe(2);
  });

  it("grants no entitlements for a consumer pack", async () => {
    const app = buildApp();
    const { userId } = await signupUser(app);
    const payload = webhookEvent({
      client_reference_id: userId,
      metadata: { userId, credits: "999999", packId: "starter" },
    });
    const { req, res, getJson } = fakeReqRes(payload);
    await handleStripeWebhook(req, res);
    expect(getJson().skipped).toBeUndefined();
    expect(await balanceOf(userId)).toBe(50 + 400);
    expect(await entitlementsOf(userId)).toHaveLength(0);
  });

  it("fails closed on an unknown packId: no credits, no entitlements", async () => {
    const app = buildApp();
    const { userId } = await signupUser(app);
    const payload = webhookEvent({
      client_reference_id: userId,
      metadata: { userId, credits: "400", packId: "nope" },
    });
    const { req, res, getJson } = fakeReqRes(payload);
    await handleStripeWebhook(req, res);
    expect(getJson()).toMatchObject({ received: true, skipped: "missing metadata" });
    expect(await balanceOf(userId)).toBe(50);
    expect(await entitlementsOf(userId)).toHaveLength(0);
  });

  it("a parked $199 purchase claims its entitlements on signup", async () => {
    const app = buildApp();
    const park = fakeReqRes(
      webhookEvent({ customer_email: "parked-finalread@x.io" })
    );
    await handleStripeWebhook(park.req, park.res);
    expect(park.getJson()).toMatchObject({ received: true, skipped: "user_missing_parked" });

    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: "parked-finalread@x.io", password: "supersecret1" });
    expect(signup.status).toBe(201);
    expect(signup.body.user.credits).toBe(50 + 400);
    const rows = await entitlementsOf(signup.body.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].remaining).toBe(2);
  });
});

describe("project-intelligence re-scan flow", () => {
  async function firstReview(app: any, cookie: string, content: string, extra: any = {}) {
    return request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content }], finalread: true, ...extra });
  }

  it("first FinalRead review freezes the version and returns its id", async () => {
    const app = buildApp();
    const { userId, cookie } = await signupUser(app);
    const res = await firstReview(app, cookie, CLEAN);
    expect(res.status).toBe(200);
    expect(typeof res.body.finalreadReviewId).toBe("string");
    expect(res.body.rescanEntitlementUsed).toBe(false);
    expect(res.body.codeUnchanged).toBeUndefined();
    // The first review is credit-charged as today (tiny corpus: 1 credit).
    expect(await balanceOf(userId)).toBe(50 - 1);
    const versions = await getDb().all<any>(
      "SELECT * FROM finalread_review_versions WHERE user_id = $1",
      [userId]
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(res.body.finalreadReviewId);
  });

  it("identical code is free and consumes nothing; changed code consumes one entitlement without charging", async () => {
    const app = buildApp();
    const { userId, cookie } = await signupUser(app);
    const first = await firstReview(app, cookie, CLEAN);
    expect(first.status).toBe(200);
    const reviewId = first.body.finalreadReviewId as string;
    // Simulate the $199 purchase (the webhook path is covered above).
    await grantRescanEntitlements(userId, "finalread", "evt_route_1", new Date());
    expect(await countRemainingEntitlements(userId)).toBe(2);
    const balanceAfterFirst = await balanceOf(userId);

    // Identical code: no charge, no consumption, buyer is told.
    const same = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content: CLEAN }], finalreadReviewId: reviewId });
    expect(same.status).toBe(200);
    expect(same.body.codeUnchanged).toBe(true);
    expect(same.body.finalreadReviewId).toBe(reviewId);
    expect(await balanceOf(userId)).toBe(balanceAfterFirst);
    expect(await countRemainingEntitlements(userId)).toBe(2);

    // Drain the balance below the 40-credit gate: an entitlement-covered
    // re-scan must still go through.
    await setBalance(userId, 10);
    const rescan = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content: CHANGED }], finalreadReviewId: reviewId });
    expect(rescan.status).toBe(200);
    expect(rescan.body.rescanEntitlementUsed).toBe(true);
    expect(rescan.body.rescanEntitlementsRemaining).toBe(1);
    expect(rescan.body.finalreadReviewId).toBe(reviewId);
    expect(await balanceOf(userId)).toBe(10);
    expect(await countRemainingEntitlements(userId)).toBe(1);

    // The new code is now the frozen version: re-running it is identical.
    const sameAgain = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content: CHANGED }], finalreadReviewId: reviewId });
    expect(sameAgain.status).toBe(200);
    expect(sameAgain.body.codeUnchanged).toBe(true);
    expect(await countRemainingEntitlements(userId)).toBe(1);

    // Second re-scan spends the last entitlement.
    const rescan2 = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content: CHANGED2 }], finalreadReviewId: reviewId });
    expect(rescan2.status).toBe(200);
    expect(rescan2.body.rescanEntitlementUsed).toBe(true);
    expect(rescan2.body.rescanEntitlementsRemaining).toBe(0);
    expect(await countRemainingEntitlements(userId)).toBe(0);

    // No entitlements left and 10 credits: the gate applies (402).
    const broke = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({
        codeFiles: [{ path: "server.js", content: CLEAN }],
        finalreadReviewId: reviewId,
      });
    expect(broke.status).toBe(402);
    expect(broke.body.code).toBe("INSUFFICIENT_CREDITS");

    // Topped up, the same changed code is credit-charged normally.
    await setBalance(userId, 100);
    const paid = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({
        codeFiles: [{ path: "server.js", content: CLEAN }],
        finalreadReviewId: reviewId,
      });
    expect(paid.status).toBe(200);
    expect(paid.body.rescanEntitlementUsed).toBe(false);
    expect(await balanceOf(userId)).toBe(100 - 1);
  });

  it("expired entitlements fall back to the credit charge", async () => {
    const app = buildApp();
    const { userId, cookie } = await signupUser(app);
    const first = await firstReview(app, cookie, CLEAN);
    const reviewId = first.body.finalreadReviewId as string;
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await grantRescanEntitlements(userId, "finalread", "evt_route_expired", old);
    const before = await balanceOf(userId);
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content: CHANGED }], finalreadReviewId: reviewId });
    expect(res.status).toBe(200);
    expect(res.body.rescanEntitlementUsed).toBe(false);
    expect(await balanceOf(userId)).toBe(before - 1);
  });

  it("a workspace scan never touches entitlements or freezes a version", async () => {
    const app = buildApp();
    const { userId, cookie } = await signupUser(app);
    await grantRescanEntitlements(userId, "finalread", "evt_route_ws", new Date());
    const before = await balanceOf(userId);
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content: CLEAN }] });
    expect(res.status).toBe(200);
    expect(res.body.finalreadReviewId).toBeUndefined();
    expect(await countRemainingEntitlements(userId)).toBe(2);
    expect(await balanceOf(userId)).toBe(before - 1);
    const versions = await getDb().all<any>(
      "SELECT * FROM finalread_review_versions WHERE user_id = $1",
      [userId]
    );
    expect(versions).toHaveLength(0);
  });

  it("a failed re-scan consumes nothing and does not advance the frozen version", async () => {
    const app = buildApp();
    const { userId, cookie } = await signupUser(app);
    const first = await firstReview(app, cookie, CLEAN);
    const reviewId = first.body.finalreadReviewId as string;
    await grantRescanEntitlements(userId, "finalread", "evt_route_fail", new Date());
    mockedFallback.mockImplementationOnce(async () => {
      throw new Error("429 RESOURCE_EXHAUSTED: Quota exceeded");
    });
    const failed = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content: CHANGED }], finalreadReviewId: reviewId });
    expect(failed.status).toBe(500);
    expect(await countRemainingEntitlements(userId)).toBe(2);
    // The frozen version is still the original: re-running the changed
    // code is still a change, not identical.
    const retry = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content: CHANGED }], finalreadReviewId: reviewId });
    expect(retry.status).toBe(200);
    expect(retry.body.codeUnchanged).toBeUndefined();
    expect(retry.body.rescanEntitlementUsed).toBe(true);
  });

  it("an unknown or foreign review id is treated as a first review", async () => {
    const app = buildApp();
    const { userId, cookie } = await signupUser(app);
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", cookie)
      .send({ codeFiles: [{ path: "server.js", content: CLEAN }], finalreadReviewId: "frv_nope" });
    expect(res.status).toBe(200);
    expect(typeof res.body.finalreadReviewId).toBe("string");
    expect(res.body.finalreadReviewId).not.toBe("frv_nope");
    expect(res.body.codeUnchanged).toBeUndefined();
  });
});

describe("billing packs endpoint: audience filtering", () => {
  function packsApp() {
    const app = express();
    app.use(express.json());
    app.use(billingRouter);
    return app;
  }

  it("finalread audience lists only the $199 pack", async () => {
    const app = packsApp();
    const res = await request(app).get("/api/billing/packs?audience=finalread");
    expect(res.status).toBe(200);
    expect(res.body.packs.map((p: any) => p.id)).toEqual(["finalread"]);
    const pack = res.body.packs[0];
    expect(pack.priceCents).toBe(19900);
    expect(pack.tagline).toContain("2 re-scans");
  });

  it("default audience lists only the three consumer packs", async () => {
    const app = packsApp();
    const res = await request(app).get("/api/billing/packs");
    expect(res.status).toBe(200);
    expect(res.body.packs.map((p: any) => p.id).sort()).toEqual(["builder", "pro", "starter"]);
    expect(res.body.packs.some((p: any) => p.id === "finalread")).toBe(false);
  });
});
