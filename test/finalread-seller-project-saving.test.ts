// FinalRead seller project saving (spec Revision 2, §13): the versioned
// transaction model exercised end-to-end against the real SQLite store —
// projects, invite codes, checkout reservation, webhook activation,
// losing-payment refund, the missing-audit report job, Q&A re-gating,
// version history, and closure retention. Gemini is mocked (canned
// intelligence); Stripe is mocked at the stripe-client boundary (no live
// calls); the webhook signature is real.
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

/** Seller saves a project, seeds its files, and runs the initial scan. */
async function seedProject(
  app: any,
  seller: { userId: string; cookie: string },
  content: string = CLEAN
): Promise<{ projectId: string; reviewId: string; scanScore: number }> {
  const created = await request(app)
    .post("/api/finalread/projects")
    .set("Cookie", seller.cookie)
    .send({ title: "Test Project" });
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
  };
}

async function issueCode(
  app: any,
  sellerCookie: string,
  projectId: string
): Promise<{ code: string; id: string }> {
  const issued = await request(app)
    .post(`/api/finalread/projects/${projectId}/invite-codes`)
    .set("Cookie", sellerCookie)
    .send({});
  expect(issued.status).toBe(201);
  return { code: issued.body.code as string, id: issued.body.inviteCode.id as string };
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
  expect(typeof checkout.body.url).toBe("string");
  const event = webhookEvent({
    client_reference_id: buyer.userId,
    customer_email: buyer.email,
    metadata: {
      userId: buyer.userId,
      packId: "finalread",
      inviteCodeId: codeId,
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

describe("seller projects: save, list, and seller-only access (§7, §8)", () => {
  it("saves a project in the seller's workspace and lists it", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const created = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "Whistle Stop" });
    expect(created.status).toBe(201);
    expect(created.body.project.title).toBe("Whistle Stop");
    expect(created.body.project.status).toBe("draft");
    const list = await request(app)
      .get("/api/finalread/projects")
      .set("Cookie", seller.cookie);
    expect(list.status).toBe(200);
    expect(list.body.projects.map((p: any) => p.id)).toContain(created.body.project.id);
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
    const stranger = await signupUser(app, "seller-saving-stranger");
    const created = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "Private" });
    const projectId = created.body.project.id as string;
    for (const path of [
      `/api/finalread/projects/${projectId}`,
      `/api/finalread/projects/${projectId}/invite-codes`,
    ]) {
      const res = await request(app).get(path).set("Cookie", stranger.cookie);
      expect(res.status).toBe(404);
    }
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

describe("invite codes: hash-only storage, expiry, and one buyer (§9)", () => {
  it("issues a code whose hash — never the plaintext — is stored", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const { projectId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);
    expect(typeof code).toBe("string");
    expect(code.length).toBe(8);
    const row = await getDb().get<any>(
      "SELECT * FROM finalread_invite_codes WHERE id = $1",
      [id]
    );
    expect(row).toBeTruthy();
    expect(row.code_hash).toBe(hashInviteCode(code));
    expect(row.code_hash).not.toBe(code);
    expect(row.status).toBe("issued");
    await clearWorkspaceFiles(seller.userId);
  });

  it("refuses to issue a code before the initial scan", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const created = await request(app)
      .post("/api/finalread/projects")
      .set("Cookie", seller.cookie)
      .send({ title: "No scan yet" });
    const res = await request(app)
      .post(`/api/finalread/projects/${created.body.project.id}/invite-codes`)
      .set("Cookie", seller.cookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it("validates a good code, rejects a bad one, and rejects an expired one", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);

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

    // Expire the code (30-day expiry if never activated).
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().run("UPDATE finalread_invite_codes SET expires_at = $1 WHERE id = $2", [
      past,
      id,
    ]);
    const expired = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code });
    expect(expired.body.valid).toBe(false);
    await clearWorkspaceFiles(seller.userId);
  });

  it("revokes an unactivated code on seller request; an activated code cannot be revoked", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId } = await seedProject(app, seller);
    const first = await issueCode(app, seller.cookie, projectId);
    const second = await issueCode(app, seller.cookie, projectId);

    const revoked = await request(app)
      .post(`/api/finalread/projects/${projectId}/invite-codes/${first.id}/revoke`)
      .set("Cookie", seller.cookie);
    expect(revoked.status).toBe(200);
    const row = await getDb().get<any>(
      "SELECT status FROM finalread_invite_codes WHERE id = $1",
      [first.id]
    );
    expect(row.status).toBe("revoked");
    const validate = await request(app)
      .post("/api/finalread/invite-codes/validate")
      .set("Cookie", buyer.cookie)
      .send({ code: first.code });
    expect(validate.body.valid).toBe(false);

    // Pay with the second code, then it cannot be revoked.
    await checkoutAndPay(app, buyer, second.code, projectId, second.id);
    const revokePaid = await request(app)
      .post(`/api/finalread/projects/${projectId}/invite-codes/${second.id}/revoke`)
      .set("Cookie", seller.cookie);
    expect(revokePaid.status).toBe(404);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("checkout reservation: one buyer, 30 minutes, server metadata (§9.6)", () => {
  it("carries the code + project ids in Stripe metadata and reserves the code", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);

    mockedStripeFetch.mockClear();
    const checkout = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyer.cookie)
      .send({ packId: "finalread", inviteCode: code });
    expect(checkout.status).toBe(200);
    const params = mockedStripeFetch.mock.calls[0][1] as Record<string, string>;
    expect(params["metadata[inviteCodeId]"]).toBe(id);
    expect(params["metadata[projectId]"]).toBe(projectId);
    expect(params["metadata[userId]"]).toBe(buyer.userId);
    expect(params["metadata[packId]"]).toBe("finalread");
    expect(params["metadata[credits]"]).toBeUndefined();
    const expiresAt = Number(params["expires_at"]);
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 1700);
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1800);

    const row = await getDb().get<any>(
      "SELECT * FROM finalread_invite_codes WHERE id = $1",
      [id]
    );
    expect(row.status).toBe("reserved");
    expect(row.reserved_by).toBe(buyer.userId);
    await clearWorkspaceFiles(seller.userId);
  });

  it("a second buyer gets 409 while the code is reserved; expiry frees it", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyerA = await signupUser(app, "seller-saving-buyer-a");
    const buyerB = await signupUser(app, "seller-saving-buyer-b");
    const { projectId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);

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
    await getDb().run("UPDATE finalread_invite_codes SET reserved_until = $1 WHERE id = $2", [
      past,
      id,
    ]);
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
    const { projectId } = await seedProject(app, seller);
    const { code } = await issueCode(app, seller.cookie, projectId);
    const res = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyer.cookie)
      .send({ packId: "starter", inviteCode: code });
    expect(res.status).toBe(400);
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("webhook activation from the pending audit (§5.2, §10; criterion 5)", () => {
  it("activates the code, grants credits + entitlements, and generates the report", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId, scanScore } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);
    const balanceBefore = await balanceOf(buyer.userId);

    const { eventId } = await checkoutAndPay(app, buyer, code, projectId, id);

    // Credits + entitlements granted from server code, never metadata.
    expect(await balanceOf(buyer.userId)).toBe(balanceBefore + 400);
    expect(await countRemainingEntitlements(buyer.userId)).toBe(2);
    // The code is activated for this buyer; the project is active.
    const codeRow = await getDb().get<any>(
      "SELECT * FROM finalread_invite_codes WHERE id = $1",
      [id]
    );
    expect(codeRow.status).toBe("activated");
    expect(codeRow.buyer_user_id).toBe(buyer.userId);
    expect(codeRow.used_at).toBeTruthy();
    const access = await getDb().get<any>(
      "SELECT * FROM finalread_buyer_access WHERE review_id = $1",
      [reviewId]
    );
    expect(access).toBeTruthy();
    expect(access.buyer_user_id).toBe(buyer.userId);
    expect(access.stripe_event_id).toBe(eventId);
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

  it("revokes every other unactivated code for the project on activation", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId } = await seedProject(app, seller);
    const first = await issueCode(app, seller.cookie, projectId);
    const second = await issueCode(app, seller.cookie, projectId);
    await checkoutAndPay(app, buyer, first.code, projectId, first.id);
    const row = await getDb().get<any>(
      "SELECT status FROM finalread_invite_codes WHERE id = $1",
      [second.id]
    );
    expect(row.status).toBe("revoked");
    // A second buyer cannot pay for this project anymore.
    const other = await signupUser(app, "seller-saving-buyer-2");
    const blocked = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", other.cookie)
      .send({ packId: "finalread", inviteCode: second.code });
    expect(blocked.status).toBe(400);
    await clearWorkspaceFiles(seller.userId);
  });

  it("the webhook is idempotent on retry: no double activation, no double grant", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);
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
        inviteCodeId: id,
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
    await clearWorkspaceFiles(seller.userId);
  });
});

describe("losing payment: activation fails, buyer keeps the pack, $199 is refunded (§9.7; criteria 15–16)", () => {
  it("refunds the losing buyer and records it; the winner keeps the report", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyerA = await signupUser(app, "seller-saving-buyer-a");
    const buyerB = await signupUser(app, "seller-saving-buyer-b");
    const { projectId, reviewId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);

    // A checks out first and holds the reservation.
    const checkoutA = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyerA.cookie)
      .send({ packId: "finalread", inviteCode: code });
    expect(checkoutA.status).toBe(200);
    // A's reservation lapses before A's webhook arrives; B reserves and pays.
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().run("UPDATE finalread_invite_codes SET reserved_until = $1 WHERE id = $2", [
      past,
      id,
    ]);
    const { eventId: eventB, paymentIntent: piB } = await checkoutAndPay(
      app,
      buyerB,
      code,
      projectId,
      id
    );
    expect(piB).toBeTruthy();
    // B has the report.
    const reportB = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyerB.cookie);
    expect(reportB.status).toBe(200);

    // A's webhook now arrives: the code is already activated, so A loses.
    mockedRefund.mockClear();
    const balanceBefore = await balanceOf(buyerA.userId);
    const eventA = webhookEvent({
      client_reference_id: buyerA.userId,
      customer_email: buyerA.email,
      metadata: {
        userId: buyerA.userId,
        packId: "finalread",
        inviteCodeId: id,
        projectId,
      },
    });
    const delivered = await deliverWebhook(eventA);
    expect(delivered.status).toBe(200);
    // A keeps the pack (credits + entitlements) — only the report access is lost.
    expect(await balanceOf(buyerA.userId)).toBe(balanceBefore + 400);
    expect(await countRemainingEntitlements(buyerA.userId)).toBe(2);
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
    expect(refund.invite_code_id).toBe(id);
    // A still cannot read the report.
    const reportA = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyerA.cookie);
    expect(reportA.status).toBe(403);
    expect(eventB).toBeTruthy();
    await clearWorkspaceFiles(seller.userId);
  });

  it("a failed refund is recorded, never silently lost", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyerA = await signupUser(app, "seller-saving-buyer-a");
    const buyerB = await signupUser(app, "seller-saving-buyer-b");
    const { projectId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);
    await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", buyerA.cookie)
      .send({ packId: "finalread", inviteCode: code });
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().run("UPDATE finalread_invite_codes SET reserved_until = $1 WHERE id = $2", [
      past,
      id,
    ]);
    await checkoutAndPay(app, buyerB, code, projectId, id);
    mockedRefund.mockRejectedValueOnce(new Error("stripe down"));
    const eventA = webhookEvent({
      client_reference_id: buyerA.userId,
      customer_email: buyerA.email,
      metadata: {
        userId: buyerA.userId,
        packId: "finalread",
        inviteCodeId: id,
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
    const { projectId, reviewId, scanScore } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);
    // The pending audit is gone (the edge case): the payment must still
    // stand, and the report is generated by a server-side scan.
    await getDb().run(
      "DELETE FROM finalread_audit_snapshots WHERE review_id = $1 AND status = $2",
      [reviewId, "pending"]
    );
    await checkoutAndPay(app, buyer, code, projectId, id);
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
    const { projectId, reviewId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);
    await getDb().run(
      "DELETE FROM finalread_audit_snapshots WHERE review_id = $1 AND status = $2",
      [reviewId, "pending"]
    );
    await checkoutAndPay(app, buyer, code, projectId, id);
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
    const { projectId, reviewId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);
    await checkoutAndPay(app, buyer, code, projectId, id);
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
    const { reviewId } = await seedProject(app, seller);
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
    const { projectId, reviewId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);
    await checkoutAndPay(app, buyer, code, projectId, id);
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
  it("closing hides the project but keeps the report, access, and Q&A; unactivated codes are revoked", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const buyer = await signupUser(app, "seller-saving-buyer");
    const { projectId, reviewId } = await seedProject(app, seller);
    const { code, id } = await issueCode(app, seller.cookie, projectId);
    await checkoutAndPay(app, buyer, code, projectId, id);
    const fetched = await request(app)
      .get(`/api/finalread/reviews/${reviewId}/report`)
      .set("Cookie", buyer.cookie);
    await request(app)
      .post("/api/finalread/ask")
      .set("Cookie", buyer.cookie)
      .send({ question: "What's the biggest risk?", reportId: fetched.body.reportId });

    // A second, still-unpaid project with an unactivated code.
    const { projectId: project2 } = await seedProject(app, seller);
    const { code: code2, id: code2Id } = await issueCode(app, seller.cookie, project2);

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
    // The activated code and buyer access survive; the unactivated code is revoked.
    const activated = await getDb().get<any>(
      "SELECT status FROM finalread_invite_codes WHERE id = $1",
      [id]
    );
    expect(activated.status).toBe("activated");
    const revoked = await getDb().get<any>(
      "SELECT status FROM finalread_invite_codes WHERE id = $1",
      [code2Id]
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

describe("free seller scan boundary: all four conditions, or the gate applies (§7.1, §10)", () => {
  it("the initial scan of a draft project is free", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    expect(await balanceOf(seller.userId)).toBe(50);
    await seedProject(app, seller);
    expect(await balanceOf(seller.userId)).toBe(50);
    await clearWorkspaceFiles(seller.userId);
  });

  it("a re-run of the initial scan with changed code is gated and charged", async () => {
    const app = buildApp();
    const seller = await signupUser(app);
    const { projectId } = await seedProject(app, seller);
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
    const { projectId } = await seedProject(app, seller);
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
    const { projectId } = await seedProject(app, seller);
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
    const { projectId } = await seedProject(app, seller);
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", buyer.cookie)
      .send({ projectId });
    expect(res.status).toBe(404);
    await clearWorkspaceFiles(seller.userId);
  });
});
