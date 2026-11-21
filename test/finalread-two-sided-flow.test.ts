// FinalRead two-sided flow, Revision 3 (§9 acceptance criteria).
// Exercised end-to-end against the real SQLite store: the bind-time
// identity rule (atomic bind, one winner), the request-creation rate
// limits, the losing-payment path on the webhook AND on the claim path
// (activate first, grant second — a loser keeps nothing), close-while-
// reserved, the DB-backed scan-in-progress guard, the buyer/seller
// identity matrix, the host entrance predicate, and the ledger guard
// (no source text in a stored or served report). Gemini is mocked
// (canned intelligence); Stripe is mocked at the stripe-client boundary
// (no live calls); the webhook signature is real.
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

// The same canned response, except one ledger entry smuggles source text
// in a `content` field — the ledger guard must drop it before the report
// is stored or served.
const LEDGER_LEAK_SNIPPET = "two-sided-flow-ledger-guard-7f3a";
const CANNED_INTEL_WITH_SOURCE = {
  ...CANNED_INTEL,
  fileLedger: [
    {
      filePath: "server.js",
      lineCount: 3,
      description: "The entrypoint.",
      content: `const SECRET = "${LEDGER_LEAK_SNIPPET}"; // source text that must never reach the buyer`,
    },
    { filePath: "lib.js", lineCount: 10, description: "A clean entry." },
  ],
};

import { generateWithFallback } from "../server/gemini";
import { createStripeRefund } from "../server/stripe-client";
import authRouter from "../server/routes/auth";
import intelligenceRouter from "../server/routes/intelligence";
import finalreadRouter from "../server/routes/finalread";
import finalreadProjectsRouter from "../server/routes/finalread-projects";
import billingRouter, { handleStripeWebhook } from "../server/routes/billing";
import { initStore, getDb } from "../server/store";
import { clearWorkspaceFiles, saveWorkspaceFile } from "../server/workspace-store";
import {
  createProjectWithRequest,
  createReviewRequest,
  releaseScanGuard,
  tryAcquireScanGuard,
} from "../server/finalread-projects";
import { countRemainingEntitlements } from "../server/finalread-rescans";
import {
  buildFinalReadReport,
  stripLedgerSourceText,
} from "../shared/finalread-report";
import { isFinalReadHost } from "../src/utils/pricing-audience";

const mockedFallback = vi.mocked(generateWithFallback);
const mockedRefund = vi.mocked(createStripeRefund);

const SECRET = ["whsec", "test", "two-sided", "flow"].join("_");
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
    id: `evt_test_twosided_${eventCounter}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        payment_status: "paid",
        payment_intent: `pi_test_twosided_${eventCounter}`,
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

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.PRICE_FINALREAD = "price_test_finalread";
  await initStore();
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
  if (savedPrice === undefined) delete process.env.PRICE_FINALREAD;
  else process.env.PRICE_FINALREAD = savedPrice;
});

let userCounter = 0;
async function signupUser(
  app: any,
  emailPrefix = "twosided"
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
  const row = await getDb().get<any>("SELECT credits_balance FROM users WHERE id = $1", [userId]);
  return row.credits_balance as number;
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
  buyer: { userId: string; cookie: string }
): Promise<{ code: string; id: string }> {
  const created = await request(app)
    .post("/api/finalread/review-requests")
    .set("Cookie", buyer.cookie)
    .send({ title: "Test Deal" });
  expect(created.status).toBe(201);
  expect(typeof created.body.code).toBe("string");
  expect(created.body.code.length).toBe(8);
  return { code: created.body.code as string, id: created.body.request.id as string };
}

/** One full deal: buyer request → seller save → initial scan. */
async function seedDeal(
  app: any,
  seller: { userId: string; cookie: string },
  buyer: { userId: string; cookie: string }
): Promise<{
  projectId: string;
  reviewId: string;
  scanScore: number;
  code: string;
  requestId: string;
}> {
  const { code, id: requestId } = await createRequest(app, buyer);
  const created = await request(app)
    .post("/api/finalread/projects")
    .set("Cookie", seller.cookie)
    .send({ title: "Test Project", requestCode: code });
  expect(created.status).toBe(201);
  const projectId = created.body.project.id as string;
  await saveWorkspaceFile(seller.userId, "server.js", CLEAN);
  const scan = await request(app)
    .post("/api/project-intelligence")
    .set("Cookie", seller.cookie)
    .send({ projectId });
  expect(scan.status).toBe(200);
  expect(typeof scan.body.finalreadReviewId).toBe("string");
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

async function pendingAuditFor(reviewId: string): Promise<any[]> {
  return getDb().all<any>(
    "SELECT * FROM finalread_audit_snapshots WHERE review_id = $1 AND status = $2",
    [reviewId, "pending"]
  );
}

describe("bind-time identity rule (§4b): the code's buyer can never be the seller", () => {
  it("a same-account bind is rejected (route 400, function null); a different account binds", async () => {
    const app = buildApp();
    const buyer = await signupUser(app, "twosided-buyer");
    const seller = await signupUser(app, "twosided-seller");
    const { code } = await createRequest(app, buyer);
    // The buyer themself cannot save a project against their own code.
    const selfBind = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", buyer.cookie)
      .send({ title: "Self Deal", requestCode: code });
    expect(selfBind.status).toBe(400);
    expect(selfBind.body.error).toMatch(/isn't valid/i);
    expect(await createProjectWithRequest(buyer.userId, "Self Deal", code)).toBeNull();
    // A different account binds fine — and the code is now spent.
    const bound = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "Real Deal", requestCode: code });
    expect(bound.status).toBe(201);
    expect(bound.body.project.requestId).toBeTruthy();
  });

  it("a second bind of the same code loses: the request stays bound to the first project", async () => {
    const app = buildApp();
    const buyer = await signupUser(app, "twosided-buyer");
    const sellerA = await signupUser(app, "twosided-seller-a");
    const sellerB = await signupUser(app, "twosided-seller-b");
    const { code, id: requestId } = await createRequest(app, buyer);
    const first = await createProjectWithRequest(sellerA.userId, "Deal A", code);
    expect(first).not.toBeNull();
    // The same code cannot bind a second project: the conditional UPDATE
    // matches 0 rows once the request has left 'requested', so the loser
    // gets null and the request stays bound to the winner's project.
    const second = await createProjectWithRequest(sellerB.userId, "Deal B", code);
    expect(second).toBeNull();
    const row = await getDb().get<any>(
      "SELECT status, project_id FROM finalread_review_requests WHERE id = $1",
      [requestId]
    );
    expect(row.status).toBe("uploaded");
    expect(row.project_id).toBe(first!.id);
    // NOTE: a truly concurrent race (two binds in flight at once) cannot
    // be exercised against the single-connection SQLite test store — the
    // second BEGIN IMMEDIATE throws "cannot start a transaction within a
    // transaction". The atomicity itself rests on the conditional UPDATE
    // (exactly 1 row), which is dialect-independent; this test proves it
    // from the loser's side.
  });
});

describe("request-creation rate limits (§4a)", () => {
  it("a 4th unbound request is a 429", async () => {
    const app = buildApp();
    const buyer = await signupUser(app, "twosided-buyer");
    await createRequest(app, buyer);
    await createRequest(app, buyer);
    await createRequest(app, buyer);
    const fourth = await request(app)
      .post("/api/finalread/review-requests")
      .set("Cookie", buyer.cookie)
      .send({ title: "Deal 4" });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toMatch(/open review requests/i);
  });

  it("a 6th request in a day is a 429 even when bound requests freed unbound slots", async () => {
    const app = buildApp();
    const buyer = await signupUser(app, "twosided-buyer");
    const seller = await signupUser(app, "twosided-seller");
    // Bind three requests (binding frees the unbound slot each time).
    for (let i = 0; i < 3; i += 1) {
      const { code } = await createRequest(app, buyer);
      const saved = await request(app)
        .post("/api/finalread/projects")
        .set("Cookie", seller.cookie)
        .send({ title: `Deal ${i}`, requestCode: code });
      expect(saved.status).toBe(201);
    }
    await createRequest(app, buyer);
    await createRequest(app, buyer);
    const sixth = await request(app)
      .post("/api/finalread/review-requests")
      .set("Cookie", buyer.cookie)
      .send({ title: "Deal 6" });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toMatch(/today/i);
    await clearWorkspaceFiles(seller.userId);
  });

  it("an expired request frees its unbound slot", async () => {
    const app = buildApp();
    const buyer = await signupUser(app, "twosided-buyer");
    const first = await createRequest(app, buyer);
    await createRequest(app, buyer);
    await createRequest(app, buyer);
    const blocked = await request(app)
      .post("/api/finalread/review-requests")
      .set("Cookie", buyer.cookie)
      .send({ title: "Deal 4" });
    expect(blocked.status).toBe(429);
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().run(
      "UPDATE finalread_review_requests SET expires_at = $1 WHERE id = $2",
      [past, first.id]
    );
    const freed = await request(app)
      .post("/api/finalread/review-requests")
      .set("Cookie", buyer.cookie)
      .send({ title: "Deal 4" });
    expect(freed.status).toBe(201);
  });
});

describe("losing payment (§4e, §4g): activate first, grant second — the loser keeps NOTHING", () => {
  it("webhook: activation fails → refund issued, balance and entitlements UNCHANGED", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "twosided-seller");
    const buyerA = await signupUser(app, "twosided-buyer-a");
    const buyerB = await signupUser(app, "twosided-buyer-b");
    const { projectId, reviewId, code, requestId } = await seedDeal(app, seller, buyerA);

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
    await checkoutAndPay(app, buyerB, code, projectId, requestId);
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
    expect(await balanceOf(buyerA.userId)).toBe(balanceBefore);
    expect(await countRemainingEntitlements(buyerA.userId)).toBe(0);
    const accessA = await getDb().get<any>(
      "SELECT * FROM finalread_buyer_access WHERE buyer_user_id = $1",
      [buyerA.userId]
    );
    expect(accessA).toBeUndefined();
    expect(mockedRefund).toHaveBeenCalledTimes(1);
    expect(mockedRefund.mock.calls[0][0]).toBe(eventA.data.object.payment_intent);
    const refund = await getDb().get<any>(
      "SELECT * FROM finalread_refund_records WHERE stripe_event_id = $1",
      [eventA.id]
    );
    expect(refund).toBeTruthy();
    expect(refund.status).toBe("refunded");
    const reportA = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyerA.cookie);
    expect(reportA.status).toBe(404);
    await clearWorkspaceFiles(seller.userId);
  });

  it("claim path: a parked purchase whose code already activated is refunded on signup and claims NOTHING", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "twosided-seller");
    const buyerA = await signupUser(app, "twosided-buyer-a");
    const buyerB = await signupUser(app, "twosided-buyer-b");
    const { projectId, reviewId, code, requestId } = await seedDeal(app, seller, buyerA);
    // B pays and activates the request first.
    await checkoutAndPay(app, buyerB, code, projectId, requestId);
    const reportB = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyerB.cookie);
    expect(reportB.status).toBe(200);

    // A ghost buyer paid for the same code, but their account did not
    // exist when the webhook arrived: the purchase + activation park.
    const ghostId = `ghost_${crypto.randomUUID()}`;
    const ghostEmail = "ghost-two-sided@x.io";
    mockedRefund.mockClear();
    const ghostEvent = webhookEvent({
      client_reference_id: ghostId,
      customer_email: ghostEmail,
      metadata: {
        userId: ghostId,
        packId: "finalread",
        requestCodeId: requestId,
        projectId,
      },
    });
    const parked = await deliverWebhook(ghostEvent);
    expect(parked.status).toBe(200);
    expect(parked.json).toMatchObject({ received: true, skipped: "user_missing_parked" });
    const parkedRow = await getDb().get<any>(
      "SELECT * FROM pending_credits WHERE stripe_event_id = $1",
      [ghostEvent.id]
    );
    expect(parkedRow).toBeTruthy();

    // The ghost signs up: the claim attempts the activation FIRST, it
    // fails (already activated by B), the $199 is refunded, and NOTHING
    // is claimed — not the 400 credits, not the entitlements.
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: ghostEmail, password: "supersecret1" });
    expect(signup.status).toBe(201);
    expect(signup.body.user.credits).toBe(50);
    const ghostId2 = signup.body.user.id as string;
    expect(await balanceOf(ghostId2)).toBe(50);
    expect(await countRemainingEntitlements(ghostId2)).toBe(0);
    const accessGhost = await getDb().get<any>(
      "SELECT * FROM finalread_buyer_access WHERE buyer_user_id = $1",
      [ghostId2]
    );
    expect(accessGhost).toBeUndefined();
    const parkedAfter = await getDb().get<any>(
      "SELECT * FROM pending_credits WHERE stripe_event_id = $1",
      [ghostEvent.id]
    );
    expect(parkedAfter).toBeUndefined();
    expect(mockedRefund).toHaveBeenCalledTimes(1);
    expect(mockedRefund.mock.calls[0][0]).toBe(ghostEvent.data.object.payment_intent);
    const refund = await getDb().get<any>(
      "SELECT * FROM finalread_refund_records WHERE stripe_event_id = $1",
      [ghostEvent.id]
    );
    expect(refund).toBeTruthy();
    expect(refund.status).toBe("refunded");
    expect(refund.buyer_user_id).toBe(ghostId2);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("close-while-reserved (§4i case 3)", () => {
  it("closing a project with an active checkout reservation is a 409; after expiry it succeeds", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "twosided-seller");
    const buyer = await signupUser(app, "twosided-buyer");
    const { projectId, code } = await seedDeal(app, seller, buyer);
    const checkout = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyer.cookie)
      .send({ packId: "finalread", inviteCode: code });
    expect(checkout.status).toBe(200);
    const blocked = await request(app)
      .post(`/api/finalread/projects/${projectId}/close`)
      .set("Cookie", seller.cookie);
    expect(blocked.status).toBe(409);
    // The reservation lapses: the close goes through.
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().run(
      "UPDATE finalread_review_requests SET reserved_until = $1 WHERE project_id = $2",
      [past, projectId]
    );
    const closed = await request(app)
      .post(`/api/finalread/projects/${projectId}/close`)
      .set("Cookie", seller.cookie);
    expect(closed.status).toBe(200);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("DB-backed scan-in-progress guard (§4c, §4i case 5)", () => {
  it("the guard is atomic: second acquire fails, release frees it, a stale guard is acquirable", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "twosided-seller");
    const buyer = await signupUser(app, "twosided-buyer");
    const { projectId } = await seedDeal(app, seller, buyer);
    expect(await tryAcquireScanGuard(projectId)).toBe(true);
    expect(await tryAcquireScanGuard(projectId)).toBe(false);
    await releaseScanGuard(projectId);
    expect(await tryAcquireScanGuard(projectId)).toBe(true);
    // A guard older than 30 minutes is stale and does not block.
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await getDb().run(
      "UPDATE finalread_projects SET scan_in_progress_at = $1 WHERE id = $2",
      [stale, projectId]
    );
    expect(await tryAcquireScanGuard(projectId)).toBe(true);
    await releaseScanGuard(projectId);
    await clearWorkspaceFiles(seller.userId);
  });

  it("a second scan while one runs is a 409 and the first scan's pending audit stays intact", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "twosided-seller");
    const buyer = await signupUser(app, "twosided-buyer");
    const { projectId, reviewId } = await seedDeal(app, seller, buyer);
    expect(await pendingAuditFor(reviewId)).toHaveLength(1);
    // A scan is in progress (the guard is set by another holder). The
    // code must actually change, or the identical-code early return
    // answers before the guard is ever consulted.
    await saveWorkspaceFile(seller.userId, "server.js", CHANGED);
    const now = new Date().toISOString();
    await getDb().run(
      "UPDATE finalread_projects SET scan_in_progress_at = $1 WHERE id = $2",
      [now, projectId]
    );
    const second = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({ projectId });
    expect(second.status).toBe(409);
    // The first scan's pending audit is untouched: still one, no version.
    expect(await pendingAuditFor(reviewId)).toHaveLength(1);
    const versions = await getDb().all<any>(
      "SELECT * FROM finalread_review_versions WHERE review_id = $1",
      [reviewId]
    );
    expect(versions).toHaveLength(0);
    // Once the guard goes stale the scan proceeds.
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await getDb().run(
      "UPDATE finalread_projects SET scan_in_progress_at = $1 WHERE id = $2",
      [stale, projectId]
    );
    const retry = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({ projectId });
    expect(retry.status).toBe(200);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("identity matrix (§4j): access is per-deal, never per-account", () => {
  it("a buyer paid for one deal gets nothing from another deal's report, project, or scan", async () => {
    const app = buildApp();
    const seller1 = await signupUser(app, "twosided-seller-1");
    const buyer1 = await signupUser(app, "twosided-buyer-1");
    const seller2 = await signupUser(app, "twosided-seller-2");
    const buyer2 = await signupUser(app, "twosided-buyer-2");
    const deal1 = await seedDeal(app, seller1, buyer1);
    const deal2 = await seedDeal(app, seller2, buyer2);
    await checkoutAndPay(app, buyer1, deal1.code, deal1.projectId, deal1.requestId);
    // Buyer 1's own report opens.
    const own = await request(app)
      .get(`/api/finalread/reviews/${deal1.reviewId}/report`)
      .set("Cookie", buyer1.cookie);
    expect(own.status).toBe(200);
    // Buyer 1 gets NOTHING from deal 2: the report fetch is a 404 (§9
    // item 16 — existence is hidden), same as the project and workspace
    // routes.
    const otherReport = await request(app)
      .get(`/api/finalread/reviews/${deal2.reviewId}/report`)
      .set("Cookie", buyer1.cookie);
    expect(otherReport.status).toBe(404);
    const otherProject = await request(app)
      .get(`/api/finalread/projects/${deal2.projectId}`)
      .set("Cookie", buyer1.cookie);
    expect(otherProject.status).toBe(404);
    const otherScan = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", buyer1.cookie)
      .send({ projectId: deal2.projectId, finalreadReviewId: deal2.reviewId });
    expect(otherScan.status).toBe(404);
    // Buyer 1's own project list is empty: they own no projects.
    const list = await request(app)
      .get("/api/finalread/projects")
      .set("Cookie", buyer1.cookie);
    expect(list.status).toBe(200);
    expect(list.body.projects).toHaveLength(0);
    // The sellers cannot see each other's projects either.
    const crossSeller = await request(app)
      .get(`/api/finalread/projects/${deal2.projectId}`)
      .set("Cookie", seller1.cookie);
    expect(crossSeller.status).toBe(404);
    await clearWorkspaceFiles(seller1.userId);
    await clearWorkspaceFiles(seller2.userId);
  });
});

describe("host entrance predicate (§1)", () => {
  it("isFinalReadHost is true for getfinalread.com and Railway hosts, false elsewhere", () => {
    expect(isFinalReadHost("getfinalread.com")).toBe(true);
    expect(isFinalReadHost("www.getfinalread.com")).toBe(true);
    expect(isFinalReadHost("accomplished-consideration-production-18ca.up.railway.app")).toBe(
      true
    );
    expect(isFinalReadHost("anything-123.up.railway.app")).toBe(true);
    expect(isFinalReadHost("gradevibes.com")).toBe(false);
    expect(isFinalReadHost("www.gradevibes.com")).toBe(false);
    expect(isFinalReadHost("localhost")).toBe(false);
  });
});

describe("ledger guard (§7 caveat 2): no source text reaches a stored or served report", () => {
  it("stripLedgerSourceText drops entries with non-whitelisted keys and keeps clean ones", () => {
    const report: any = {
      projectTitle: "X",
      fileLedger: [
        { filePath: "a.js", lineCount: 1, description: "clean" },
        { filePath: "b.js", content: "const secret = 1;" },
        { filePath: "c.js", source: "function leak() {}" },
        { filePath: "d.js", code: "eval(x)" },
      ],
    };
    const stripped = stripLedgerSourceText(report);
    expect(stripped.fileLedger).toHaveLength(1);
    expect(stripped.fileLedger![0].filePath).toBe("a.js");
    expect(JSON.stringify(stripped)).not.toContain("secret");
    // A clean report is returned unchanged.
    const clean: any = {
      projectTitle: "X",
      fileLedger: [{ filePath: "a.js", lineCount: 1 }],
    };
    expect(stripLedgerSourceText(clean)).toBe(clean);
    expect(stripLedgerSourceText({ projectTitle: "X" } as any).fileLedger).toBeUndefined();
  });

  it("buildFinalReadReport never carries a content/source/code field into the ledger", () => {
    const built = buildFinalReadReport({
      ...CANNED_INTEL,
      fileLedger: CANNED_INTEL_WITH_SOURCE.fileLedger,
    } as any);
    // The entry survives with its whitelisted fields only: the smuggled
    // `content` field is stripped by the sanitizer, so the entry no
    // longer carries source text.
    expect(built.fileLedger).toHaveLength(2);
    for (const entry of built.fileLedger!) {
      expect(Object.keys(entry).sort()).toEqual(
        expect.arrayContaining(["filePath"])
      );
      expect(entry).not.toHaveProperty("content");
      expect(entry).not.toHaveProperty("source");
      expect(entry).not.toHaveProperty("code");
    }
    expect(built.fileLedger![0].filePath).toBe("server.js");
    expect(JSON.stringify(built)).not.toContain(LEDGER_LEAK_SNIPPET);
  });

  it("end to end: a scan whose ledger smuggles source text stores and serves a report without it", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "twosided-seller");
    const buyer = await signupUser(app, "twosided-buyer");
    mockedFallback.mockImplementationOnce(async () => ({
      response: {
        text: JSON.stringify(CANNED_INTEL_WITH_SOURCE),
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      },
      modelName: "gemini-3.6-flash",
    }) as any);
    const { projectId, reviewId, code, requestId } = await seedDeal(app, seller, buyer);
    await checkoutAndPay(app, buyer, code, projectId, requestId);
    // The STORED report row contains no trace of the smuggled source.
    const stored = await getDb().get<any>(
      "SELECT report FROM finalread_reports WHERE review_id = $1",
      [reviewId]
    );
    expect(stored).toBeTruthy();
    expect(stored.report).not.toContain(LEDGER_LEAK_SNIPPET);
    const parsed = JSON.parse(stored.report);
    expect(parsed.fileLedger).toHaveLength(2);
    for (const entry of parsed.fileLedger) {
      expect(entry).not.toHaveProperty("content");
      expect(entry).not.toHaveProperty("source");
      expect(entry).not.toHaveProperty("code");
    }
    // Neither does the SERVED report.
    const served = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(served.status).toBe(200);
    expect(JSON.stringify(served.body)).not.toContain(LEDGER_LEAK_SNIPPET);
    await clearWorkspaceFiles(seller.userId);
  });
});
