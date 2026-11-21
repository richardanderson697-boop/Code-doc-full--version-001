// FinalRead two-sided flow (spec Revision 3, §2–§4, §9): the versioned
// transaction model exercised end-to-end against the real SQLite store —
// buyer review requests, the atomic bind, checkout reservation, webhook
// activation (activate-first, grant-second), the losing-payment refund,
// the missing-audit report job, Q&A re-gating, version history, and
// closure retention. Gemini is mocked (canned intelligence); Stripe is
// mocked at the stripe-client boundary (no live calls); the webhook
// signature is real.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
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

vi.mock("../server/stripe-client", () => ({
  stripeFetch: vi.fn(async () => ({
    url: "https://checkout.stripe.com/session/test",
    id: "cs_test_1",
  })),
  stripeGet: vi.fn(async () => ({})),
  createStripeRefund: vi.fn(async (paymentIntent: string) => ({
    id: `re_test_${paymentIntent}`,
    payment_intent: paymentIntent,
  })),
}));

// A minimal valid intelligence response: the handler overwrites every
// score from the deterministic assessment and keeps the reason strings.
const CANNED_INTEL = {
  overallSummary: "A tiny test project.",
  completenessScore: 50,
  categoryScores: {
    serverStarts: { score: 5, max: 10, reason: "Starts." },
    authentication: { score: 5, max: 10, reason: "Auth present." },
    databaseLayer: { score: 5, max: 10, reason: "DB present." },
    externalIntegrations: { score: 5, max: 10, reason: "No integrations needed." },
    errorHandling: { score: 5, max: 10, reason: "Errors handled." },
    coreLogic: { score: 5, max: 10, reason: "Logic present." },
    backgroundAutomation: { score: 5, max: 10, reason: "No automation needed." },
    security: { score: 5, max: 10, reason: "Secure enough." },
    performance: { score: 5, max: 10, reason: "Fast enough." },
    documentationVerified: { score: 5, max: 10, reason: "Documented." },
  },
  fileLedger: [],
  applicationMap: { entrypoint: "server.js", components: [], endpoints: [] },
  missingFeatures: [],
};

import { stripeFetch, createStripeRefund } from "../server/stripe-client";
import authRouter from "../server/routes/auth";
import intelligenceRouter from "../server/routes/intelligence";
import finalreadRouter from "../server/routes/finalread";
import finalreadProjectsRouter from "../server/routes/finalread-projects";
import billingRouter, { handleStripeWebhook } from "../server/routes/billing";
import { initStore, getDb } from "../server/store";
import { clearWorkspaceFiles, saveWorkspaceFile } from "../server/workspace-store";
import { countRemainingEntitlements } from "../server/finalread-rescans";
import { hashInviteCode } from "../server/finalread-projects";

const mockedStripeFetch = vi.mocked(stripeFetch);
const mockedRefund = vi.mocked(createStripeRefund);

const SECRET = ["whsec", "test", "seller", "saving"].join("_");
const CLEAN = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
const CHANGED = `export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n`;

function sign(payload: string, secret: string): string {
  const t = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

async function deliverWebhook(event: any): Promise<{ status: number; json: any }> {
  const body = JSON.stringify(event);
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
  await handleStripeWebhook(req, res);
  return { status: statusCode, json: jsonBody };
}

let eventCounter = 0;
function webhookEvent(overrides: any = {}) {
  eventCounter += 1;
  return {
    id: `evt_test_seller_${eventCounter}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        payment_status: "paid",
        payment_intent: `pi_test_seller_${eventCounter}`,
        client_reference_id: "buyer",
        metadata: { userId: "buyer", packId: "finalread" },
        customer_email: "buyer@example.com",
        ...overrides,
      },
    },
  };
}

const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
const savedPrice = process.env.PRICE_FINALREAD;
const savedStarterPrice = process.env.PRICE_STARTER;

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.PRICE_FINALREAD = "price_test_finalread";
  // The consumer-pack rejection test needs the starter pack configured
  // so checkout reaches the invite-code check instead of the 500 for an
  // unconfigured pack.
  process.env.PRICE_STARTER = "price_test_starter";
  await initStore();
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
  if (savedPrice === undefined) delete process.env.PRICE_FINALREAD;
  else process.env.PRICE_FINALREAD = savedPrice;
  if (savedStarterPrice === undefined) delete process.env.PRICE_STARTER;
  else process.env.PRICE_STARTER = savedStarterPrice;
});

let userCounter = 0;
async function signupUser(
  app: any,
  emailPrefix = "seller-saving"
): Promise<{ userId: string; cookie: string; email: string }> {
  userCounter += 1;
  const email = `${emailPrefix}-${userCounter}@x.io`;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret1" });
  expect(res.status).toBe(201);
  const raw = res.headers["set-cookie"];
  const setCookie: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = setCookie.find((c) => c.startsWith("codedoc_session="));
  expect(session).toBeTruthy();
  return { userId: res.body.user.id, cookie: session!.split(";")[0], email };
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

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authRouter);
  app.use(intelligenceRouter);
  app.use(billingRouter);
  app.use(finalreadRouter);
  app.use(finalreadProjectsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status || 500).json({ error: err?.message || "server error" });
  });
  return app;
}

/** Buyer creates a review request and gets its 8-character code ONCE. */
async function createRequest(
  app: any,
  buyerCookie: string,
  title = "Test Deal"
): Promise<{ code: string; id: string }> {
  const created = await request(app)
    .post("/api/finalread/review-requests")
    .set("Cookie", buyerCookie)
    .send({ title });
  expect(created.status).toBe(201);
  expect(typeof created.body.code).toBe("string");
  expect(created.body.code.length).toBe(8);
  return { code: created.body.code as string, id: created.body.request.id as string };
}

/**
 * Seller saves a project against the buyer's request code (the atomic
 * bind), seeds its files, and runs the initial scan (free when bound).
 */
async function seedProject(
  app: any,
  seller: { userId: string; cookie: string },
  buyer: { userId: string; cookie: string },
  content: string = CLEAN
): Promise<{ projectId: string; reviewId: string; scanScore: number; code: string; requestId: string }> {
  const { code, id: requestId } = await createRequest(app, buyer.cookie);
  const created = await request(app)
    .post("/api/finalread/projects")
    .set("Cookie", seller.cookie)
    .send({ title: "Test Project", requestCode: code });
  expect(created.status).toBe(201);
  const projectId = created.body.project.id as string;
  await saveWorkspaceFile(seller.userId, "server.js", content);
  const scan = await request(app)
    .post("/api/project-intelligence")
    .set("Cookie", seller.cookie)
    .send({ projectId });
  expect(scan.status).toBe(200);
  expect(typeof scan.body.finalreadReviewId).toBe("string");
  // The deterministic assessment overwrites the model's canned score, so
  // the pinned score is whatever the scan computed — the report must
  // carry exactly that score, not the model's number.
  expect(typeof scan.body.completenessScore).toBe("number");
  return {
    projectId,
    reviewId: scan.body.finalreadReviewId as string,
    scanScore: scan.body.completenessScore as number,
    code,
    requestId,
  };
}

/** Buyer checks out with a code (mocked Stripe) then the webhook delivers. */
async function checkoutAndPay(
  app: any,
  buyer: { userId: string; cookie: string; email: string },
  code: string,
  projectId: string,
  requestId: string
): Promise<{ eventId: string; paymentIntent: string }> {
  const checkout = await request(app)
    .post("/api/billing/checkout")
    .set("Cookie", buyer.cookie)
    .send({ packId: "finalread", inviteCode: code });
  expect(checkout.status).toBe(200);
  expect(typeof checkout.body.url).toBe("string");
  const event = webhookEvent({
    client_reference_id: buyer.userId,
    customer_email: buyer.email,
    metadata: {
      userId: buyer.userId,
      packId: "finalread",
      requestCodeId: requestId,
      projectId,
    },
  });
  const delivered = await deliverWebhook(event);
  expect(delivered.status).toBe(200);
  return { eventId: event.id, paymentIntent: event.data.object.payment_intent as string };
}

async function qaTurns(reviewId: string): Promise<any[]> {
  return getDb().all<any>(
    "SELECT * FROM finalread_qa_history WHERE review_id = $1 ORDER BY created_at ASC",
    [reviewId]
  );
}

describe("seller projects: save, list, and seller-only access (§2, §4b, §4j)", () => {
  it("saves a project against the buyer's request code and lists it", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { code } = await createRequest(app, buyer.cookie);
    const created = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "Whistle Stop", requestCode: code });
    expect(created.status).toBe(201);
    expect(created.body.project.title).toBe("Whistle Stop");
    expect(created.body.project.status).toBe("draft");
    expect(created.body.project.requestId).toBeTruthy();
    const list = await request(app)
      .get("/api/finalread/projects")
      .set("Cookie", seller.cookie);
    expect(list.status).toBe(200);
    expect(list.body.projects.map((p: any) => p.id)).toContain(created.body.project.id);
  });

  it("a save without a valid request code is rejected (§4b)", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const noCode = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "No code" });
    expect(noCode.status).toBe(400);
    const badCode = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "Bad code", requestCode: "ZZZZZZZZ" });
    expect(badCode.status).toBe(400);
    // The seller cannot bind their OWN request (bind-time identity rule).
    const own = await createRequest(app, seller.cookie);
    const selfBind = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "Self deal", requestCode: own.code });
    expect(selfBind.status).toBe(400);
  });

  it("requires a title", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const res = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "  " });
    expect(res.status).toBe(400);
  });

  it("another seller gets a 404, never a leak", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const stranger = await signupUser(app, "seller-saving-stranger");
    const { code } = await createRequest(app, buyer.cookie);
    const created = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "Private", requestCode: code });
    const projectId = created.body.project.id as string;
    const fetched = await request(app)
      .get(`/api/finalread/projects/${projectId}`)
      .set("Cookie", stranger.cookie);
    expect(fetched.status).toBe(404);
    const rebind = await request(app)
      .post(`/api/finalread/projects/${projectId}/re-bind`)
      .set("Cookie", stranger.cookie)
      .send({ requestCode: code });
    expect(rebind.status).toBe(404);
    const close = await request(app)
      .post(`/api/finalread/projects/${projectId}/close`)
      .set("Cookie", stranger.cookie);
    expect(close.status).toBe(404);
    // The stranger's own list does not contain it either.
    const list = await request(app)
      .get("/api/finalread/projects")
      .set("Cookie", stranger.cookie);
    expect(list.body.projects.map((p: any) => p.id)).not.toContain(projectId);
  });
});

describe("review requests: hash-only storage, expiry, and the pending-audit rule (§4a)", () => {
  it("creates a request whose hash — never the plaintext — is stored", async () => {
    const app = buildApp();
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { code, id } = await createRequest(app, buyer.cookie);
    expect(typeof code).toBe("string");
    expect(code.length).toBe(8);
    const row = await getDb().get<any>(
      "SELECT * FROM finalread_review_requests WHERE id = $1",
      [id]
    );
    expect(row).toBeTruthy();
    expect(row.code_hash).toBe(hashInviteCode(code));
    expect(row.code_hash).not.toBe(code);
    expect(row.status).toBe("requested");
    expect(row.buyer_user_id).toBe(buyer.userId);
  });

  it("a code validates only when bound to a project WITH a pending audit", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { code } = await createRequest(app, buyer.cookie);
    // Unbound: the seller has not saved a project against it yet.
    const unbound = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code });
    expect(unbound.body.valid).toBe(false);
    // Bound but not yet scanned: no pending audit, so no payment.
    const created = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "Test Project", requestCode: code });
    expect(created.status).toBe(201);
    const noAudit = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code });
    expect(noAudit.body.valid).toBe(false);
    // After the initial scan the code validates, with the title shown.
    await saveWorkspaceFile(seller.userId, "server.js", CLEAN);
    const scan = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({ projectId: created.body.project.id });
    expect(scan.status).toBe(200);
    const good = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code });
    expect(good.body.valid).toBe(true);
    expect(good.body.activatedForCaller).toBe(false);
    expect(good.body.projectTitle).toBe("Test Project");
    await clearWorkspaceFiles(seller.userId);
  });

  it("validates a good code, rejects a bad one, and rejects an expired one", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { code, requestId } = await seedProject(app, seller, buyer);

    const good = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code });
    expect(good.status).toBe(200);
    expect(good.body.valid).toBe(true);
    expect(good.body.activatedForCaller).toBe(false);
    expect(good.body.projectTitle).toBe("Test Project");

    const bad = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code: "ZZZZZZZZ" });
    expect(bad.body.valid).toBe(false);

    // Expire the request (30-day expiry if never activated).
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().run(
      "UPDATE finalread_review_requests SET expires_at = $1 WHERE id = $2",
      [past, requestId]
    );
    const expired = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code });
    expect(expired.body.valid).toBe(false);
    await clearWorkspaceFiles(seller.userId);
  });

  it("re-binding a draft project to a new code revokes the old request (§4b)", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, code: firstCode, requestId: firstId } = await seedProject(app, seller, buyer);
    const second = await createRequest(app, buyer.cookie, "Second deal");

    const rebound = await request(app)
      .post(`/api/finalread/projects/${projectId}/re-bind`)
      .set("Cookie", seller.cookie)
      .send({ requestCode: second.code });
    expect(rebound.status).toBe(200);
    const oldRow = await getDb().get<any>(
      "SELECT status FROM finalread_review_requests WHERE id = $1",
      [firstId]
    );
    expect(oldRow.status).toBe("revoked");
    const oldValid = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code: firstCode });
    expect(oldValid.body.valid).toBe(false);
    const newValid = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code: second.code });
    expect(newValid.body.valid).toBe(true);
    // Re-entering the code the project is already bound to is a no-op success.
    const same = await request(app)
      .post(`/api/finalread/projects/${projectId}/re-bind`)
      .set("Cookie", seller.cookie)
      .send({ requestCode: second.code });
    expect(same.status).toBe(200);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("checkout reservation: one buyer, 30 minutes, server metadata (§4d)", () => {
  it("carries the request + project ids in Stripe metadata and reserves the request", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, code, requestId } = await seedProject(app, seller, buyer);

    mockedStripeFetch.mockClear();
    const checkout = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyer.cookie)
      .send({ packId: "finalread", inviteCode: code });
    expect(checkout.status).toBe(200);
    const params = mockedStripeFetch.mock.calls[0][1] as Record<string, string>;
    expect(params["metadata[requestCodeId]"]).toBe(requestId);
    expect(params["metadata[inviteCodeId]"]).toBeUndefined();
    expect(params["metadata[projectId]"]).toBe(projectId);
    expect(params["metadata[userId]"]).toBe(buyer.userId);
    expect(params["metadata[packId]"]).toBe("finalread");
    expect(params["metadata[credits]"]).toBeUndefined();
    const expiresAt = Number(params["expires_at"]);
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 1700);
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1800);

    const row = await getDb().get<any>(
      "SELECT * FROM finalread_review_requests WHERE id = $1",
      [requestId]
    );
    expect(row.status).toBe("reserved");
    expect(row.reserved_by).toBe(buyer.userId);
    await clearWorkspaceFiles(seller.userId);
  });

  it("a second buyer gets 409 while the request is reserved; expiry frees it", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyerA = await signupUser(app, "seller-saving-buyer-a");
    const buyerB = await signupUser(app, "seller-saving-buyer-b");
    const { projectId, code, requestId } = await seedProject(app, seller, buyerA);

    const first = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyerA.cookie)
      .send({ packId: "finalread", inviteCode: code });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyerB.cookie)
      .send({ packId: "finalread", inviteCode: code });
    expect(second.status).toBe(409);
    const validate = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyerB.cookie)
      .send({ code });
    expect(validate.body.valid).toBe(false);

    // The reservation lapses: the second buyer can now reserve it.
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().run(
      "UPDATE finalread_review_requests SET reserved_until = $1 WHERE id = $2",
      [past, requestId]
    );
    const retry = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyerB.cookie)
      .send({ packId: "finalread", inviteCode: code });
    expect(retry.status).toBe(200);
    await clearWorkspaceFiles(seller.userId);
  });

  it("rejects an invite code on a consumer pack", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { code } = await seedProject(app, seller, buyer);
    const res = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyer.cookie)
      .send({ packId: "starter", inviteCode: code });
    expect(res.status).toBe(400);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("webhook activation from the pending audit (§4e, §5.2; criterion 5)", () => {
  it("activates the request, grants credits + entitlements, and generates the report", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId, scanScore, code, requestId } = await seedProject(app, seller, buyer);
    const balanceBefore = await balanceOf(buyer.userId);

    const { eventId } = await checkoutAndPay(app, buyer, code, projectId, requestId);

    // Credits + entitlements granted from server code, never metadata.
    expect(await balanceOf(buyer.userId)).toBe(balanceBefore + 400);
    expect(await countRemainingEntitlements(buyer.userId)).toBe(2);
    // The request is activated for this buyer; the project is active.
    const requestRow = await getDb().get<any>(
      "SELECT * FROM finalread_review_requests WHERE id = $1",
      [requestId]
    );
    expect(requestRow.status).toBe("activated");
    expect(requestRow.buyer_user_id).toBe(buyer.userId);
    expect(requestRow.used_at).toBeTruthy();
    const access = await getDb().get<any>(
      "SELECT * FROM finalread_buyer_access WHERE review_id = $1",
      [reviewId]
    );
    expect(access).toBeTruthy();
    expect(access.buyer_user_id).toBe(buyer.userId);
    expect(access.stripe_event_id).toBe(eventId);
    expect(access.invite_code_id).toBe(requestId);
    const project = await getDb().get<any>(
      "SELECT * FROM finalread_projects WHERE id = $1",
      [projectId]
    );
    expect(project.status).toBe("active");
    // The report exists: version 1 generated from the pending audit.
    const reports = await getDb().all<any>(
      "SELECT * FROM finalread_reports WHERE review_id = $1",
      [reviewId]
    );
    expect(reports).toHaveLength(1);
    const versions = await getDb().all<any>(
      "SELECT * FROM finalread_review_versions WHERE review_id = $1",
      [reviewId]
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].version_number).toBe(1);
    const snapshot = await getDb().get<any>(
      "SELECT * FROM finalread_audit_snapshots WHERE review_id = $1",
      [reviewId]
    );
    expect(snapshot.status).toBe("active");
    expect(snapshot.version_id).toBe(versions[0].id);
    // The buyer can fetch the report; the seller can too (post-payment parity).
    const buyerReport = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(buyerReport.status).toBe(200);
    // The report is generated from the pending audit: the pinned score.
    expect(buyerReport.body.report.completenessScore).toBe(scanScore);
    const sellerReport = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", seller.cookie);
    expect(sellerReport.status).toBe(200);
    await clearWorkspaceFiles(seller.userId);
  });

  it("one buyer per project: after activation no other buyer can pay for it", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, code, requestId } = await seedProject(app, seller, buyer);
    await checkoutAndPay(app, buyer, code, projectId, requestId);
    // A second buyer's own request is unbound — it cannot pay for this
    // project, and the paid project cannot be re-bound to it.
    const other = await signupUser(app, "seller-saving-buyer-2");
    const otherRequest = await createRequest(app, other.cookie, "Other deal");
    const blocked = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", other.cookie)
      .send({ packId: "finalread", inviteCode: otherRequest.code });
    expect(blocked.status).toBe(400);
    const rebind = await request(app)
      .post(`/api/finalread/projects/${projectId}/re-bind`)
      .set("Cookie", seller.cookie)
      .send({ requestCode: otherRequest.code });
    expect(rebind.status).toBe(404);
    await clearWorkspaceFiles(seller.userId);
  });

  it("the webhook is idempotent on retry: no double activation, no double grant", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId, code, requestId } = await seedProject(app, seller, buyer);
    const checkout = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyer.cookie)
      .send({ packId: "finalread", inviteCode: code });
    expect(checkout.status).toBe(200);
    const event = webhookEvent({
      client_reference_id: buyer.userId,
      customer_email: buyer.email,
      metadata: {
        userId: buyer.userId,
        packId: "finalread",
        requestCodeId: requestId,
        projectId,
      },
    });
    const first = await deliverWebhook(event);
    expect(first.status).toBe(200);
    const balanceAfterFirst = await balanceOf(buyer.userId);
    const second = await deliverWebhook(event);
    expect(second.status).toBe(200);
    expect(await balanceOf(buyer.userId)).toBe(balanceAfterFirst);
    expect(await countRemainingEntitlements(buyer.userId)).toBe(2);
    const accessRows = await getDb().all<any>(
      "SELECT * FROM finalread_buyer_access WHERE review_id = $1",
      [reviewId]
    );
    expect(accessRows).toHaveLength(1);
    const reports = await getDb().all<any>(
      "SELECT * FROM finalread_reports WHERE review_id = $1",
      [reviewId]
    );
    expect(reports).toHaveLength(1);
    // The retry did not refund a payment that already succeeded.
    expect(mockedRefund).not.toHaveBeenCalled();
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("losing payment: activation fails, $199 is refunded, NOTHING is granted (§4e; criteria 15–16)", () => {
  it("refunds the losing buyer and records it; the loser keeps no credits and no entitlements", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyerA = await signupUser(app, "seller-saving-buyer-a");
    const buyerB = await signupUser(app, "seller-saving-buyer-b");
    const { projectId, reviewId, code, requestId } = await seedProject(app, seller, buyerA);

    // A checks out first and holds the reservation.
    const checkoutA = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyerA.cookie)
      .send({ packId: "finalread", inviteCode: code });
    expect(checkoutA.status).toBe(200);
    // A's reservation lapses before A's webhook arrives; B reserves and pays.
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().run(
      "UPDATE finalread_review_requests SET reserved_until = $1 WHERE id = $2",
      [past, requestId]
    );
    const { eventId: eventB, paymentIntent: piB } = await checkoutAndPay(
      app,
      buyerB,
      code,
      projectId,
      requestId
    );
    expect(piB).toBeTruthy();
    // B has the report.
    const reportB = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyerB.cookie);
    expect(reportB.status).toBe(200);

    // A's webhook now arrives: the request is already activated, so A loses.
    mockedRefund.mockClear();
    const balanceBefore = await balanceOf(buyerA.userId);
    const eventA = webhookEvent({
      client_reference_id: buyerA.userId,
      customer_email: buyerA.email,
      metadata: {
        userId: buyerA.userId,
        packId: "finalread",
        requestCodeId: requestId,
        projectId,
      },
    });
    const delivered = await deliverWebhook(eventA);
    expect(delivered.status).toBe(200);
    // Activate-first, grant-second: A gets NOTHING — no credits, no
    // entitlements. The old grants-first order gave the pack away.
    expect(await balanceOf(buyerA.userId)).toBe(balanceBefore);
    expect(await countRemainingEntitlements(buyerA.userId)).toBe(0);
    const accessA = await getDb().get<any>(
      "SELECT * FROM finalread_buyer_access WHERE buyer_user_id = $1",
      [buyerA.userId]
    );
    expect(accessA).toBeUndefined();
    // The $199 was refunded via Stripe and recorded.
    expect(mockedRefund).toHaveBeenCalledTimes(1);
    expect(mockedRefund.mock.calls[0][0]).toBe(eventA.data.object.payment_intent);
    const refund = await getDb().get<any>(
      "SELECT * FROM finalread_refund_records WHERE stripe_event_id = $1",
      [eventA.id]
    );
    expect(refund).toBeTruthy();
    expect(refund.status).toBe("refunded");
    expect(refund.buyer_user_id).toBe(buyerA.userId);
    expect(refund.invite_code_id).toBe(requestId);
    // A still cannot read the report.
    const reportA = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyerA.cookie);
    expect(reportA.status).toBe(404);
    expect(eventB).toBeTruthy();
    await clearWorkspaceFiles(seller.userId);
  });

  it("a failed refund is recorded, never silently lost", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyerA = await signupUser(app, "seller-saving-buyer-a");
    const buyerB = await signupUser(app, "seller-saving-buyer-b");
    const { projectId, code, requestId } = await seedProject(app, seller, buyerA);
    await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyerA.cookie)
      .send({ packId: "finalread", inviteCode: code });
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().run(
      "UPDATE finalread_review_requests SET reserved_until = $1 WHERE id = $2",
      [past, requestId]
    );
    await checkoutAndPay(app, buyerB, code, projectId, requestId);
    mockedRefund.mockRejectedValueOnce(new Error("stripe down"));
    const eventA = webhookEvent({
      client_reference_id: buyerA.userId,
      customer_email: buyerA.email,
      metadata: {
        userId: buyerA.userId,
        packId: "finalread",
        requestCodeId: requestId,
        projectId,
      },
    });
    await deliverWebhook(eventA);
    const refund = await getDb().get<any>(
      "SELECT * FROM finalread_refund_records WHERE stripe_event_id = $1",
      [eventA.id]
    );
    expect(refund).toBeTruthy();
    expect(refund.status).toBe("failed");
    expect(refund.error).toMatch(/stripe down/);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("missing audit: payment stands, report generates by server-side scan (§5.2; criterion 5)", () => {
  it("activates without a report, enqueues a job, and the fetch completes it", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId, scanScore, code, requestId } = await seedProject(app, seller, buyer);
    // The pending audit is gone (the edge case): the payment must still
    // stand, and the report is generated by a server-side scan.
    await getDb().run(
      "DELETE FROM finalread_audit_snapshots WHERE review_id = $1 AND status = $2",
      [reviewId, "pending"]
    );
    await checkoutAndPay(app, buyer, code, projectId, requestId);
    const access = await getDb().get<any>(
      "SELECT * FROM finalread_buyer_access WHERE review_id = $1",
      [reviewId]
    );
    expect(access).toBeTruthy();
    expect(await countRemainingEntitlements(buyer.userId)).toBe(2);
    const job = await getDb().get<any>(
      "SELECT * FROM finalread_report_jobs WHERE review_id = $1",
      [reviewId]
    );
    expect(job).toBeTruthy();
    expect(job.status).toBe("pending");
    // The fetch retries the job and lands the report — the same code the
    // initial scan graded, so the same deterministic score.
    const fetched = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(fetched.status).toBe(200);
    expect(fetched.body.report.completenessScore).toBe(scanScore);
    const done = await getDb().get<any>(
      "SELECT * FROM finalread_report_jobs WHERE review_id = $1",
      [reviewId]
    );
    expect(done.status).toBe("done");
    await clearWorkspaceFiles(seller.userId);
  });

  it("a failing job leaves the buyer at 'generating' (202) and the next fetch retries", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId, code, requestId } = await seedProject(app, seller, buyer);
    await getDb().run(
      "DELETE FROM finalread_audit_snapshots WHERE review_id = $1 AND status = $2",
      [reviewId, "pending"]
    );
    await checkoutAndPay(app, buyer, code, projectId, requestId);
    // The scan fails once: the fetch answers 202, the job is failed.
    const { generateWithFallback } = await import("../server/gemini");
    vi.mocked(generateWithFallback).mockRejectedValueOnce(new Error("model down"));
    const generating = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(generating.status).toBe(202);
    expect(generating.body.status).toBe("generating");
    const failed = await getDb().get<any>(
      "SELECT * FROM finalread_report_jobs WHERE review_id = $1",
      [reviewId]
    );
    expect(failed.status).toBe("failed");
    // The next fetch retries and lands the report.
    const fetched = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(fetched.status).toBe(200);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("Q&A re-gating: paid buyer first, client audit ignored (§5.4, §8, §10; criterion 10)", () => {
  async function paidSetup(app: any) {
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId, code, requestId } = await seedProject(app, seller, buyer);
    await checkoutAndPay(app, buyer, code, projectId, requestId);
    const fetched = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(fetched.status).toBe(200);
    return { seller, buyer, projectId, reviewId, reportId: fetched.body.reportId as string };
  }

  it("the seller with credits but no paid access is rejected, gets no answer, is not charged", async () => {
    const app = buildApp();
    const { seller, buyer, reviewId, reportId } = await paidSetup(app);
    const balanceBefore = await balanceOf(seller.userId);
    // A starter question would answer deterministically if authorized —
    // the 403 proves the gate, not the model.
    const res = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", seller.cookie)
      .send({ question: "What's the biggest risk?", reportId });
    expect(res.status).toBe(403);
    expect(res.body.answer).toBeUndefined();
    expect(await balanceOf(seller.userId)).toBe(balanceBefore);
    expect(await qaTurns(reviewId)).toHaveLength(0);
    // The buyer asks the same question and gets an answer + a recorded turn.
    const buyerRes = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", buyer.cookie)
      .send({ question: "What's the biggest risk?", reportId });
    expect(buyerRes.status).toBe(200);
    expect(buyerRes.body.starter).toBe(true);
    expect(await qaTurns(reviewId)).toHaveLength(1);
    await clearWorkspaceFiles(seller.userId);
  });

  it("a client-supplied audit does not bypass the gate", async () => {
    const app = buildApp();
    const { seller, reviewId, reportId } = await paidSetup(app);
    const fakeAudit = {
      projectTitle: "Forged App",
      completenessScore: 100,
      categoryScores: {},
    };
    const res = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", seller.cookie)
      .send({ question: "What's the biggest risk?", reportId, audit: fakeAudit });
    expect(res.status).toBe(403);
    expect(await qaTurns(reviewId)).toHaveLength(0);
    await clearWorkspaceFiles(seller.userId);
  });

  it("a stranger is rejected, an unknown report is a 404, a missing report id is a 400", async () => {
    const app = buildApp();
    const { seller, buyer, reportId } = await paidSetup(app);
    const stranger = await signupUser(app, "seller-saving-stranger");
    const strangerRes = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", stranger.cookie)
      .send({ question: "What's the biggest risk?", reportId });
    expect(strangerRes.status).toBe(403);
    const unknown = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", buyer.cookie)
      .send({ question: "What's the biggest risk?", reportId: "frr_nope" });
    expect(unknown.status).toBe(404);
    const missing = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", buyer.cookie)
      .send({ question: "What's the biggest risk?" });
    expect(missing.status).toBe(400);
    await clearWorkspaceFiles(seller.userId);
  });

  it("the seller sees the full Q&A log (option (a)); the buyer sees their own", async () => {
    const app = buildApp();
    const { seller, buyer, reviewId, reportId } = await paidSetup(app);
    await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", buyer.cookie)
      .send({ question: "What's the biggest risk?", reportId });
    const sellerLog = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/qa-log`)
      .set("Cookie", seller.cookie);
    expect(sellerLog.status).toBe(200);
    expect(sellerLog.body.turns).toHaveLength(1);
    expect(sellerLog.body.turns[0].question).toBe("What's the biggest risk?");
    const buyerLog = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/qa-log`)
      .set("Cookie", buyer.cookie);
    expect(buyerLog.status).toBe(200);
    expect(buyerLog.body.turns).toHaveLength(1);
    const stranger = await signupUser(app, "seller-saving-stranger");
    const strangerLog = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/qa-log`)
      .set("Cookie", stranger.cookie);
    expect(strangerLog.status).toBe(404);
    await clearWorkspaceFiles(seller.userId);
  });

  it("the seller cannot fetch the report before payment (developer view only)", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { reviewId } = await seedProject(app, seller, buyer);
    const before = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", seller.cookie);
    expect(before.status).toBe(403);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("version history is preserved, never overwritten (§12.1; criterion 20)", () => {
  it("a re-scan creates a new immutable version; the old report still stands", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId, code, requestId } = await seedProject(app, seller, buyer);
    await checkoutAndPay(app, buyer, code, projectId, requestId);
    const first = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    const v1ReportId = first.body.reportId as string;
    const v1VersionId = first.body.versionId as string;

    // The buyer re-scans changed code against the entitlement.
    await saveWorkspaceFile(seller.userId, "server.js", CHANGED);
    const rescan = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", buyer.cookie)
      .send({ projectId, finalreadReviewId: reviewId });
    expect(rescan.status).toBe(200);
    expect(rescan.body.rescanEntitlementUsed).toBe(true);
    expect(rescan.body.finalreadReportId).toBeTruthy();
    expect(rescan.body.finalreadReportId).not.toBe(v1ReportId);

    // History: two versions, different hashes, both reports fetchable.
    const detail = await request(app)
      .get(`/api/finalread/reviews/${reviewId}`)
      .set("Cookie", buyer.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.versions).toHaveLength(2);
    expect(detail.body.versions[0].versionNumber).toBe(1);
    expect(detail.body.versions[1].versionNumber).toBe(2);
    expect(detail.body.versions[0].contentHash).not.toBe(detail.body.versions[1].contentHash);
    expect(detail.body.versions[0].id).toBe(v1VersionId);
    const oldReport = await request(app)
      .get(`/api/finalread/reports/${v1ReportId}`)
      .set("Cookie", buyer.cookie);
    expect(oldReport.status).toBe(200);
    const latest = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(latest.body.reportId).toBe(rescan.body.finalreadReportId);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("project closure retains the paid records (§7.2; criterion 21)", () => {
  it("closing hides the project but keeps the report, access, and Q&A; unactivated requests are revoked", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId, code, requestId } = await seedProject(app, seller, buyer);
    await checkoutAndPay(app, buyer, code, projectId, requestId);
    const fetched = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", buyer.cookie)
      .send({ question: "What's the biggest risk?", reportId: fetched.body.reportId });

    // A second, still-unpaid project with an unactivated request.
    const buyer2 = await signupUser(app, "seller-saving-buyer-2");
    const { projectId: project2, code: code2, requestId: request2Id } = await seedProject(
      app,
      seller,
      buyer2
    );

    const closed = await request(app)
      .post(`/api/finalread/projects/${projectId}/close`)
      .set("Cookie", seller.cookie);
    expect(closed.status).toBe(200);
    const closed2 = await request(app)
      .post(`/api/finalread/projects/${project2}/close`)
      .set("Cookie", seller.cookie);
    expect(closed2.status).toBe(200);

    // Hidden from the seller's active list, visible with includeClosed.
    const list = await request(app)
      .get("/api/finalread/projects")
      .set("Cookie", seller.cookie);
    expect(list.body.projects.map((p: any) => p.id)).not.toContain(projectId);
    const all = await request(app)
      .get("/api/finalread/projects?includeClosed=true")
      .set("Cookie", seller.cookie);
    expect(all.body.projects.find((p: any) => p.id === projectId)?.status).toBe("closed");
    // The buyer keeps the report and the Q&A log.
    const report = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(report.status).toBe(200);
    const log = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/qa-log`)
      .set("Cookie", buyer.cookie);
    expect(log.status).toBe(200);
    expect(log.body.turns).toHaveLength(1);
    // The activated request and buyer access survive; the unactivated request is revoked.
    const activated = await getDb().get<any>(
      "SELECT status FROM finalread_review_requests WHERE id = $1",
      [requestId]
    );
    expect(activated.status).toBe("activated");
    const revoked = await getDb().get<any>(
      "SELECT status FROM finalread_review_requests WHERE id = $1",
      [request2Id]
    );
    expect(revoked.status).toBe("revoked");
    const validate = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code: code2 });
    expect(validate.body.valid).toBe(false);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("free seller scan boundary: all five conditions, or the gate applies (§2, §4b)", () => {
  it("the initial scan of a draft project bound to a buyer request is free", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    expect(await balanceOf(seller.userId)).toBe(50);
    const { projectId } = await seedProject(app, seller, buyer);
    expect(await balanceOf(seller.userId)).toBe(50);
    // The project is bound — the fifth gate condition holds.
    const project = await getDb().get<any>(
      "SELECT request_id FROM finalread_projects WHERE id = $1",
      [projectId]
    );
    expect(project.request_id).toBeTruthy();
    await clearWorkspaceFiles(seller.userId);
  });

  it("an unbound project is NOT free: the fifth condition closes the ungated gap", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    // A legacy project row with no bound request (pre-Rev3 shape): the
    // free scan must not apply — the seller pays the credit gate.
    const projectId = `frp_legacy_${Date.now()}`;
    const now = new Date().toISOString();
    await getDb().run(
      "INSERT INTO finalread_projects (id, seller_user_id, title, finalread_review_id, purchase_stripe_event_id, request_id, scan_in_progress_at, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [projectId, seller.userId, "Legacy", null, null, null, null, "draft", now, now]
    );
    await saveWorkspaceFile(seller.userId, "server.js", CLEAN);
    const scan = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({ projectId });
    expect(scan.status).toBe(200);
    expect(await balanceOf(seller.userId)).toBe(50 - 1);
    await clearWorkspaceFiles(seller.userId);
  });

  it("a re-run of the initial scan with changed code is gated and charged", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId } = await seedProject(app, seller, buyer);
    await saveWorkspaceFile(seller.userId, "server.js", CHANGED);
    const rerun = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({ projectId });
    expect(rerun.status).toBe(200);
    expect(await balanceOf(seller.userId)).toBe(50 - 1);
    await clearWorkspaceFiles(seller.userId);
  });

  it("a broke seller cannot re-run the initial scan (402)", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId } = await seedProject(app, seller, buyer);
    await setBalance(seller.userId, 10);
    await saveWorkspaceFile(seller.userId, "server.js", CHANGED);
    const rerun = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({ projectId });
    expect(rerun.status).toBe(402);
    expect(rerun.body.code).toBe("INSUFFICIENT_CREDITS");
    await clearWorkspaceFiles(seller.userId);
  });

  it("client-supplied codeFiles or paths with a projectId are rejected (criterion 12)", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId } = await seedProject(app, seller, buyer);
    const withFiles = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({ projectId, codeFiles: [{ path: "evil.js", content: "x" }] });
    expect(withFiles.status).toBe(400);
    const withPaths = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({ projectId, paths: ["server.js"] });
    expect(withPaths.status).toBe(400);
    await clearWorkspaceFiles(seller.userId);
  });

  it("a buyer cannot start a scan from a project without naming the review", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId } = await seedProject(app, seller, buyer);
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", buyer.cookie)
      .send({ projectId });
    expect(res.status).toBe(404);
    await clearWorkspaceFiles(seller.userId);
  });
});
