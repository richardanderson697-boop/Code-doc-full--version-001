// FinalRead stakeholder-view gate (gate spec §9, two-sided flow Rev 3):
// the stakeholder view renders ONLY from a stored paid report — never
// from a raw scan audit. Exercised end-to-end against the real SQLite
// store: the workspace scan (developer view only), the retired entry flow
// (new entry scans are a 400; legacy entry re-runs still work), the
// buyer-initiated project flow (payment prompt before payment, stored
// report after), post-payment parity, re-scan version gating, the
// re-gated Q&A, and the static check that no raw-audit overlay path
// remains. Gemini is mocked (canned intelligence); Stripe is mocked at
// the stripe-client boundary (no live calls); the webhook signature is
// real.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";
import fs from "fs";
import path from "path";

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

import authRouter from "../server/routes/auth";
import intelligenceRouter from "../server/routes/intelligence";
import finalreadRouter from "../server/routes/finalread";
import finalreadProjectsRouter from "../server/routes/finalread-projects";
import billingRouter, { handleStripeWebhook } from "../server/routes/billing";
import { initStore, getDb } from "../server/store";
import { saveWorkspaceFile } from "../server/workspace-store";
import { createEntryReview } from "../server/finalread-projects";
import { hashReviewContent, countRemainingEntitlements } from "../server/finalread-rescans";

const SECRET = ["whsec", "test", "stakeholder", "gate"].join("_");
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
    id: `evt_test_gate_${eventCounter}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        payment_status: "paid",
        payment_intent: `pi_test_gate_${eventCounter}`,
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
  emailPrefix = "gate"
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

async function setBalance(userId: string, balance: number): Promise<void> {
  await getDb().run("UPDATE users SET credits_balance = $1 WHERE id = $2", [balance, userId]);
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

/** A legacy entry review (pre-Rev3), seeded directly: the entry upload
 *  flow is retired, so no route can create one any more. */
async function seedLegacyEntryReview(
  app: any,
  user: { userId: string; cookie: string },
  content: string = CLEAN
): Promise<{ reviewId: string }> {
  await saveWorkspaceFile(user.userId, "server.js", content);
  await setBalance(user.userId, 500);
  const review = await createEntryReview(user.userId);
  const hash = hashReviewContent([{ path: "server.js", content }]);
  await getDb().run(
    "INSERT INTO finalread_audit_snapshots (id, version_id, review_id, audit, content_hash, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [
      `fas_${crypto.randomUUID()}`,
      null,
      review.id,
      JSON.stringify({ ...CANNED_INTEL, completenessScore: 50 }),
      hash,
      "pending",
      new Date().toISOString(),
    ]
  );
  return { reviewId: review.id };
}

/** Buyer creates a review request; the seller saves a project against it
 *  and runs the initial scan from it. */
async function createRequest(
  app: any,
  buyer: { userId: string; cookie: string }
): Promise<{ code: string; id: string }> {
  const created = await request(app)
    .post("/api/finalread/review-requests")
    .set("Cookie", buyer.cookie)
    .send({ title: "Test Project" });
  expect(created.status).toBe(201);
  expect(typeof created.body.code).toBe("string");
  expect(created.body.code.length).toBe(8);
  return { code: created.body.code as string, id: created.body.request.id as string };
}

/** Seller saves a project and runs the initial scan from it. */
async function seedProject(
  app: any,
  seller: { userId: string; cookie: string },
  buyer: { userId: string; cookie: string },
  content: string = CLEAN
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
  await saveWorkspaceFile(seller.userId, "server.js", content);
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
  codeId: string
): Promise<{ eventId: string; paymentIntent: string }> {
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
      requestCodeId: codeId,
      projectId,
    },
  });
  const delivered = await deliverWebhook(event);
  expect(delivered.status).toBe(200);
  return { eventId: event.id, paymentIntent: event.data.object.payment_intent as string };
}

/** Buyer pays for the $199 pack directly (entry flow: no invite code). */
async function payFinalReadPack(
  app: any,
  buyer: { userId: string; cookie: string; email: string }
): Promise<{ eventId: string; paymentIntent: string }> {
  const checkout = await request(app)
    .post("/api/billing/checkout")
    .set("Cookie", buyer.cookie)
    .send({ packId: "finalread" });
  expect(checkout.status).toBe(200);
  const event = webhookEvent({
    client_reference_id: buyer.userId,
    customer_email: buyer.email,
    metadata: { userId: buyer.userId, packId: "finalread" },
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

async function qaTurns(reviewId: string): Promise<any[]> {
  return getDb().all<any>(
    "SELECT * FROM finalread_qa_history WHERE review_id = $1 ORDER BY created_at ASC",
    [reviewId]
  );
}

describe("workspace scan: developer view only, no stakeholder view (§9.1, §9.8)", () => {
  it("a plain workspace scan returns the audit (developer view) and creates no review or report", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    await saveWorkspaceFile(seller.userId, "server.js", CLEAN);
    await setBalance(seller.userId, 500);
    const scan = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({});
    expect(scan.status).toBe(200);
    // The developer view (the free showing) is intact: scores, findings,
    // evidence, file ledger, summary — the fields the workspace renders
    // and the ledger copy uses.
    expect(typeof scan.body.completenessScore).toBe("number");
    expect(scan.body.categoryScores).toBeTruthy();
    expect(Array.isArray(scan.body.fileLedger)).toBe(true);
    expect(typeof scan.body.overallSummary).toBe("string");
    // But no FinalRead review was created and no report exists: there is
    // nothing for a stakeholder view to open from a workspace scan.
    expect(scan.body.finalreadReviewId).toBeUndefined();
    expect(scan.body.finalreadReportId).toBeUndefined();
    const missing = await request(app)
      .get("/api/finalread/reviews/frv_does_not_exist/report")
      .set("Cookie", seller.cookie);
    expect(missing.status).toBe(404);
  });
});

describe("entry flow retired (§11, §8): new entry scans are a 400; legacy entry re-runs still work", () => {
  it("a new entry scan (finalread: true, no review id, no project) is retired with a 400", async () => {
    const app = buildApp();
    const buyer = await signupUser(app, "gate-entry");
    await saveWorkspaceFile(buyer.userId, "server.js", CLEAN);
    await setBalance(buyer.userId, 500);
    const scan = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", buyer.cookie)
      .send({ finalread: true });
    expect(scan.status).toBe(400);
    expect(scan.body.error).toMatch(/retired/i);
    // No review was created: there is nothing for a stakeholder view to
    // open from an entry scan any more.
    const reviews = await getDb().all<any>(
      "SELECT * FROM finalread_reviews WHERE seller_user_id = $1",
      [buyer.userId]
    );
    expect(reviews).toHaveLength(0);
  });

  it("a bare $199 purchase without a code grants the pack but activates no code and opens no report", async () => {
    const app = buildApp();
    const buyer = await signupUser(app, "gate-entry-bare");
    const before = await balanceOf(buyer.userId);
    await payFinalReadPack(app, buyer);
    expect(await balanceOf(buyer.userId)).toBe(before + 400);
    expect(await countRemainingEntitlements(buyer.userId)).toBe(2);
    const access = await getDb().all<any>(
      "SELECT * FROM finalread_buyer_access WHERE buyer_user_id = $1",
      [buyer.userId]
    );
    expect(access).toHaveLength(0);
  });

  it("a legacy entry re-run without a project id still works (gate spec §8)", async () => {
    const app = buildApp();
    const buyer = await signupUser(app, "gate-entry-rerun");
    const { reviewId } = await seedLegacyEntryReview(app, buyer);
    // Unchanged code is not a re-scan: free, no new version.
    const rerun = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", buyer.cookie)
      .send({ finalreadReviewId: reviewId });
    expect(rerun.status).toBe(200);
    expect(rerun.body.codeUnchanged).toBe(true);
    // Changed code before payment replaces the pending audit (the newest
    // scan is the pinned assessment) — still one pending snapshot.
    await saveWorkspaceFile(buyer.userId, "server.js", CHANGED);
    const rerunChanged = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", buyer.cookie)
      .send({ finalreadReviewId: reviewId });
    expect(rerunChanged.status).toBe(200);
    expect(rerunChanged.body.finalreadReviewId).toBe(reviewId);
    const pending = await pendingAuditFor(reviewId);
    expect(pending).toHaveLength(1);
  });

  it("a project review re-run without a project id still 400s", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "gate-project-rerun");
    const buyer = await signupUser(app, "gate-project-rerun-buyer");
    const { reviewId } = await seedProject(app, seller, buyer);
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", seller.cookie)
      .send({ finalreadReviewId: reviewId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project id/i);
  });
});

describe("seller adopted mode + post-payment parity (§9.4, §9.5)", () => {
  it("the seller gets a 403 (waiting state) before payment and the SAME stored report as the buyer after payment", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "gate-seller");
    const buyer = await signupUser(app, "gate-buyer");
    const { projectId, reviewId, scanScore, code, requestId: codeId } = await seedProject(
      app,
      seller,
      buyer
    );
    // Before payment the seller cannot fetch the report: the waiting
    // state, not the stakeholder view.
    const before = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", seller.cookie);
    expect(before.status).toBe(403);
    expect(before.body.report).toBeUndefined();
    await checkoutAndPay(app, buyer, code, projectId, codeId);
    // After payment the seller AND the buyer see the SAME stored report.
    const sellerView = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", seller.cookie);
    const buyerView = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(sellerView.status).toBe(200);
    expect(buyerView.status).toBe(200);
    expect(sellerView.body).toEqual(buyerView.body);
    expect(sellerView.body.report.completenessScore).toBe(scanScore);
  });
});

describe("direct fetch: not-found before payment, stored report after (§9.6)", () => {
  it("a report id that does not exist yet is a 404; after payment the same id returns the stored report", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "gate-direct-seller");
    const buyer = await signupUser(app, "gate-direct-buyer");
    const { projectId, reviewId, code, requestId: codeId } = await seedProject(app, seller, buyer);
    const missing = await request(app)
      .get("/api/finalread/reports/frr_does_not_exist")
      .set("Cookie", buyer.cookie);
    expect(missing.status).toBe(404);
    await checkoutAndPay(app, buyer, code, projectId, codeId);
    const fetched = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(fetched.status).toBe(200);
    const byId = await request(app)
      .get(`/api/finalread/reports/${fetched.body.reportId}`)
      .set("Cookie", buyer.cookie);
    expect(byId.status).toBe(200);
    expect(byId.body.report).toEqual(fetched.body.report);
    // A stranger gets nothing, even after payment.
    const stranger = await signupUser(app, "gate-direct-stranger");
    const denied = await request(app)
      .get(`/api/finalread/reports/${fetched.body.reportId}`)
      .set("Cookie", stranger.cookie);
    expect(denied.status).toBe(404);
  });
});

describe("re-scan version gating (§9.7)", () => {
  it("a paid re-scan creates a new version + report; the old version's report stays viewable", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "gate-rescan-seller");
    const buyer = await signupUser(app, "gate-rescan-buyer");
    const { projectId, reviewId, scanScore, code, requestId: codeId } = await seedProject(
      app,
      seller,
      buyer
    );
    await checkoutAndPay(app, buyer, code, projectId, codeId);
    const before = await request(app)
      .get(`/api/finalread/reviews/${reviewId}`)
      .set("Cookie", buyer.cookie);
    expect(before.body.versions).toHaveLength(1);
    const oldReportId = before.body.versions[0].reportId as string;
    expect(oldReportId).toBeTruthy();
    // The seller fixes the code; the buyer re-scans with an entitlement.
    await saveWorkspaceFile(seller.userId, "server.js", CHANGED);
    const rescan = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", buyer.cookie)
      .send({ projectId, finalreadReviewId: reviewId });
    expect(rescan.status).toBe(200);
    expect(rescan.body.rescanEntitlementUsed).toBe(true);
    expect(typeof rescan.body.finalreadReportId).toBe("string");
    expect(rescan.body.finalreadReportId).not.toBe(oldReportId);
    const after = await request(app)
      .get(`/api/finalread/reviews/${reviewId}`)
      .set("Cookie", buyer.cookie);
    expect(after.body.versions).toHaveLength(2);
    expect(after.body.versions[1].reportId).toBe(rescan.body.finalreadReportId);
    // The old version's report is still viewable (it was paid for).
    const oldReport = await request(app)
      .get(`/api/finalread/reports/${oldReportId}`)
      .set("Cookie", buyer.cookie);
    expect(oldReport.status).toBe(200);
    expect(oldReport.body.report.completenessScore).toBe(scanScore);
    // The latest report is the new version's.
    const latest = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(latest.status).toBe(200);
    expect(latest.body.reportId).toBe(rescan.body.finalreadReportId);
  });
});

describe("Q&A stays re-gated (§9.9)", () => {
  it("the seller cannot ask before or after payment; the buyer can after payment; a client-supplied audit is rejected", async () => {
    const app = buildApp();
    const seller = await signupUser(app, "gate-qa-seller");
    const buyer = await signupUser(app, "gate-qa-buyer");
    const { projectId, reviewId, code, requestId: codeId } = await seedProject(app, seller, buyer);
    // No report exists yet: nothing to ask about.
    const unpaid = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", seller.cookie)
      .send({ question: "Is this app actually finished?", reviewId });
    expect(unpaid.status).toBe(404);
    // A client-supplied audit is not a way in: the route requires a
    // report id.
    const forged = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", seller.cookie)
      .send({
        question: "Is this app actually finished?",
        audit: { completenessScore: 99, categoryScores: {}, findings: [] },
      });
    expect(forged.status).toBe(400);
    await checkoutAndPay(app, buyer, code, projectId, codeId);
    const paid = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    expect(paid.status).toBe(200);
    const reportId = paid.body.reportId as string;
    // The seller sees the Q&A log but cannot ask, even with credits.
    await setBalance(seller.userId, 500);
    const sellerAsk = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", seller.cookie)
      .send({ question: "Is this app actually finished?", reportId });
    expect(sellerAsk.status).toBe(403);
    expect(await qaTurns(reviewId)).toHaveLength(0);
    // The buyer who paid can ask (deterministic starter, no model call).
    const buyerAsk = await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", buyer.cookie)
      .send({ question: "Is this app actually finished?", reportId });
    expect(buyerAsk.status).toBe(200);
    expect(typeof buyerAsk.body.answer).toBe("string");
    expect(await qaTurns(reviewId)).toHaveLength(1);
  });
});

describe("waiting state contains no report content (§9.2) + no raw-audit overlay path remains (§9.10)", () => {
  it("the waiting-state surface carries no scores, findings, or verdict", () => {
    const waiting = fs.readFileSync(
      path.join(process.cwd(), "src/components/auditor/FinalReadWaiting.tsx"),
      "utf8"
    );
    expect(waiting).toContain("waiting on buyer");
    expect(waiting).not.toMatch(/completenessScore|liabilities|verdict|buildFinalReadReport/);
    expect(waiting).not.toMatch(/window\.print|downloadMarkdown|Download Q&A/);
  });

  it("no FinalReadOverlay render is fed by a raw scan audit", () => {
    const report = fs.readFileSync(
      path.join(process.cwd(), "src/components/auditor/IntelligenceReport.tsx"),
      "utf8"
    );
    const entry = fs.readFileSync(
      path.join(process.cwd(), "src/components/auditor/FinalReadEntry.tsx"),
      "utf8"
    );
    const overlay = fs.readFileSync(
      path.join(process.cwd(), "src/components/auditor/FinalReadOverlay.tsx"),
      "utf8"
    );
    // Neither render site passes a client-built audit to the overlay.
    for (const [name, src] of [
      ["IntelligenceReport", report],
      ["FinalReadEntry", entry],
    ] as const) {
      expect(src, name).not.toContain("audit={intelResultToFinalReadInput");
      expect(src, name).not.toMatch(/<FinalReadOverlay[^>]*audit=/);
    }
    // Both render sites pass the stored report + its id.
    expect(report).toContain("report={paidReport.report}");
    expect(report).toContain("reportId={paidReport.reportId}");
    expect(entry).toContain("report={paidReport.report}");
    expect(entry).toContain("reportId={paidReport.reportId}");
    // The overlay takes a stored report + report id, not an audit, and
    // its Q&A call sends the report id (no client-supplied audit).
    expect(overlay).toMatch(/report:\s*FinalReadReport/);
    expect(overlay).toMatch(/reportId:\s*string/);
    expect(overlay).not.toMatch(/audit:\s*FinalReadAuditInput;\s*\n\s*onClose/);
    expect(overlay).toContain("reportId,");
    expect(overlay).not.toContain("audit,");
  });
});
