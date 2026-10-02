// The money safety net: when the Stripe webhook arrives for a user that no
// longer exists (e.g. the database was replaced between checkout and
// delivery), credits are parked against the customer email and claimed on the
// next signup/login — never silently lost, never attached to a ghost.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";
import { handleStripeWebhook } from "../server/routes/billing";
import authRouter from "../server/routes/auth";
import { initAuthStore, getAuthDb } from "../server/authdb";

const SECRET = "whsec_test_pending_credits";

function sign(payload: string, secret: string): string {
  const t = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

let eventCounter = 0;

function webhookEvent(overrides: any = {}) {
  eventCounter += 1;
  return {
    id: `evt_test_pending_${eventCounter}`,
    type: "checkout.session.completed",
    data: {
      object: {
        payment_status: "paid",
        client_reference_id: "user-ghost-uuid",
        metadata: { userId: "user-ghost-uuid", credits: "400", packId: "starter" },
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

const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  initAuthStore();
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  return app;
}

function pendingFor(email: string) {
  return getAuthDb()
    .prepare("SELECT * FROM pending_credits WHERE email = ?")
    .all(email) as any[];
}

describe("stripe webhook: missing user", () => {
  it("credits an existing user normally", async () => {
    const app = buildApp();
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: "happy@x.io", password: "supersecret1" });
    const userId = signup.body.user.id;
    const { req, res, getJson } = fakeReqRes(
      webhookEvent({ client_reference_id: userId, metadata: { userId, credits: "400", packId: "starter" } })
    );
    await handleStripeWebhook(req, res);
    expect(getJson()).toMatchObject({ received: true });
    expect(getJson().skipped).toBeUndefined();
    const balance = getAuthDb().prepare("SELECT credits_balance FROM users WHERE id = ?").get(userId) as any;
    expect(balance.credits_balance).toBe(50 + 400);
  });

  it("parks credits by email when the user is gone", async () => {
    const { req, res, getJson } = fakeReqRes(webhookEvent());
    await handleStripeWebhook(req, res);
    expect(getJson()).toMatchObject({ received: true, skipped: "user_missing_parked" });
    const rows = pendingFor("buyer@example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].credits).toBe(400);
    // No orphan transaction attached to the ghost user id.
    const orphans = getAuthDb()
      .prepare("SELECT * FROM credit_transactions WHERE user_id = ?")
      .all("user-ghost-uuid") as any[];
    expect(orphans).toHaveLength(0);
  });

  it("is idempotent on webhook retry for a parked event", async () => {
    const payload = webhookEvent({ customer_email: "retry@x.io" });
    const first = fakeReqRes(payload);
    await handleStripeWebhook(first.req, first.res);
    const second = fakeReqRes(payload);
    await handleStripeWebhook(second.req, second.res);
    expect(pendingFor("retry@x.io")).toHaveLength(1);
  });

  it("reports when there is no customer email either", async () => {
    const { req, res, getJson } = fakeReqRes(
      webhookEvent({ customer_email: undefined, customer_details: undefined })
    );
    // ensure the key is truly absent, not JSON null
    const body = JSON.parse((req.body as Buffer).toString());
    delete body.data.object.customer_email;
    req.body = Buffer.from(JSON.stringify(body));
    req.headers["stripe-signature"] = sign(req.body.toString(), SECRET);
    await handleStripeWebhook(req, res);
    expect(getJson()).toMatchObject({ received: true, skipped: "user_missing_no_email" });
  });

  it("signup claims parked credits onto the new account", async () => {
    const app = buildApp();
    // park 400 for claimme@x.io via a ghost user id
    const park = fakeReqRes(
      webhookEvent({ customer_email: "claimme@x.io", metadata: { userId: "ghost-2", credits: "400", packId: "builder" } })
    );
    await handleStripeWebhook(park.req, park.res);
    expect(pendingFor("claimme@x.io")).toHaveLength(1);

    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: "claimme@x.io", password: "supersecret1" });
    expect(signup.status).toBe(201);
    expect(signup.body.user.credits).toBe(50 + 400);
    expect(pendingFor("claimme@x.io")).toHaveLength(0);
  });

  it("login claims parked credits too", async () => {
    const app = buildApp();
    await request(app).post("/api/auth/signup").send({ email: "loginclaim@x.io", password: "supersecret1" });
    const park = fakeReqRes(
      webhookEvent({ customer_email: "loginclaim@x.io", metadata: { userId: "ghost-3", credits: "1100", packId: "builder" } })
    );
    await handleStripeWebhook(park.req, park.res);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "loginclaim@x.io", password: "supersecret1" });
    expect(login.status).toBe(200);
    expect(login.body.user.credits).toBe(50 + 1100);
    expect(pendingFor("loginclaim@x.io")).toHaveLength(0);
  });
});
