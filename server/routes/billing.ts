// Credit-pack billing via Stripe: pack catalog, Checkout sessions, webhook.
// No stripe SDK: raw HTTPS calls keep the dependency list untouched.
import { Router } from "express";
import crypto from "crypto";
import https from "https";
import { asyncRoute } from "../async-route";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import { addCredits } from "../credits";
import { log } from "../logger";

const router = Router();

export interface Pack {
  id: string;
  name: string;
  priceCents: number;
  credits: number;
  priceId: string | undefined;
  tagline: string;
}

// Price IDs come from env so test and live modes don't share config.
// Created 2026-09-22 (test mode): Starter $10/400, Builder $25/1100, Pro $50/2400.
export function getPacks(): Pack[] {
  return [
    {
      id: "starter",
      name: "Starter",
      priceCents: 1000,
      credits: 400,
      priceId: process.env.PRICE_STARTER,
      tagline: "Try deep audits on a side project",
    },
    {
      id: "builder",
      name: "Builder",
      priceCents: 2500,
      credits: 1100,
      priceId: process.env.PRICE_BUILDER,
      tagline: "For active indie development",
    },
    {
      id: "pro",
      name: "Pro",
      priceCents: 5000,
      credits: 2400,
      priceId: process.env.PRICE_PRO,
      tagline: "Heavy auditing, best value",
    },
  ];
}

router.get("/api/billing/packs", (_req, res) => {
  res.json({
    packs: getPacks().map((p) => ({
      id: p.id,
      name: p.name,
      priceCents: p.priceCents,
      credits: p.credits,
      tagline: p.tagline,
      available: Boolean(p.priceId),
    })),
  });
});

function stripeFetch(path: string, params: Record<string, string>): Promise<any> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured");
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.stripe.com",
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res: any) => {
        let data = "";
        res.on("data", (c: any) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(json?.error?.message || `Stripe error ${res.statusCode}`));
            } else resolve(json);
          } catch (e) {
            reject(new Error(`Stripe returned non-JSON (${res.statusCode})`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function appUrl(req: any): string {
  const configured = process.env.APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${req.headers.host}`;
}

// Create a Checkout session for a credit pack. Returns the hosted URL.
router.post("/api/billing/checkout", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const { packId } = req.body ?? {};
  const pack = getPacks().find((p) => p.id === packId);
  if (!pack) return res.status(400).json({ error: "Unknown credit pack." });
  if (!pack.priceId) {
    return res.status(500).json({ error: "This pack is not configured yet. Contact support." });
  }
  const base = appUrl(req);
  try {
    const session = await stripeFetch("/v1/checkout/sessions", {
      mode: "payment",
      "line_items[0][price]": pack.priceId,
      "line_items[0][quantity]": "1",
      success_url: `${base}/?checkout=success&pack=${pack.id}`,
      cancel_url: `${base}/?checkout=cancelled`,
      client_reference_id: req.user!.id,
      "metadata[userId]": req.user!.id,
      "metadata[credits]": String(pack.credits),
      "metadata[packId]": pack.id,
      customer_email: req.user!.email,
    });
    res.json({ url: session.url });
  } catch (err: any) {
    log.error("Stripe checkout failed:", err);
    res.status(502).json({ error: "Could not start checkout. Try again in a moment." });
  }
}));

// ---- Webhook ----
// Mounted in server.ts with express.raw() BEFORE the JSON body parser, because
// Stripe's signature covers the exact raw bytes.
export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  const timestamp = parts["t"];
  const signatures = signatureHeader.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  // Reject replays older than 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  return signatures.some((sig) => {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

export async function handleStripeWebhook(req: any, res: any): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    log.error("Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set");
    return res.status(500).json({ error: "Webhook not configured" });
  }
  const rawBody: Buffer = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: "Expected raw body" });
  }
  if (!verifyStripeSignature(rawBody, req.headers["stripe-signature"] as string | undefined, secret)) {
    log.warn("Stripe webhook: signature verification failed");
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object ?? {};
    if (session.payment_status !== "paid") {
      return res.json({ received: true, skipped: "unpaid" });
    }
    const userId = session.metadata?.userId || session.client_reference_id;
    const credits = Number(session.metadata?.credits ?? 0);
    const eventId = event.id;
    if (!userId || !credits) {
      log.warn("Stripe webhook: completed session missing userId/credits metadata");
      return res.json({ received: true, skipped: "missing metadata" });
    }
    // addCredits is idempotent on the Stripe event id: safe to retry.
    const balance = addCredits(userId, credits, `credit pack: ${session.metadata?.packId ?? "pack"}`, `stripe:${eventId}`);
    log.info(`Credited ${credits} to user ${userId} (Stripe ${eventId}); balance now ${balance}`);
  }

  res.json({ received: true });
}

export default router;
