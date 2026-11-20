// Raw Stripe HTTPS calls (no Stripe SDK, to keep the dependency list
// untouched). Split out of server/routes/billing.ts so tests can mock the
// transport without mocking the whole billing router.
import https from "https";
import { log } from "./logger";

export function stripeFetch(path: string, params: Record<string, string>): Promise<any> {
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

export function stripeGet(path: string): Promise<any> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.stripe.com",
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Stripe-Version": "2024-06-20",
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
    req.setTimeout(15000, () => req.destroy(new Error("Stripe request timed out")));
    req.end();
  });
}

/**
 * Refund a payment in full via the Stripe refunds API. Used by the
 * FinalRead losing-payment path (spec §9.7): a payment that succeeded but
 * whose invite-code activation failed is refunded, never silently kept.
 * Returns the refund object. Throws on a Stripe error — the caller records
 * the failure so it can be reconciled.
 */
export async function createStripeRefund(paymentIntentId: string): Promise<any> {
  if (!paymentIntentId) throw new Error("No payment intent to refund");
  log.info(`Issuing Stripe refund for payment intent ${paymentIntentId}`);
  return stripeFetch("/v1/refunds", {
    payment_intent: paymentIntentId,
  });
}
