// The webhook is the money path: signature verification must be exact,
// replays must be rejected, and tampered payloads must fail.
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifyStripeSignature } from "../server/routes/billing";

const SECRET = "whsec_test_123";

function sign(payload: string, secret: string, timestamp?: string): string {
  const t = timestamp ?? String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed payload", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const header = sign(payload, SECRET);
    expect(verifyStripeSignature(Buffer.from(payload), header, SECRET)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const header = sign(payload, SECRET);
    const tampered = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    expect(verifyStripeSignature(Buffer.from(tampered), header, SECRET)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const header = sign(payload, "whsec_wrong");
    expect(verifyStripeSignature(Buffer.from(payload), header, SECRET)).toBe(false);
  });

  it("rejects replays older than 5 minutes", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const old = String(Math.floor(Date.now() / 1000) - 600);
    const header = sign(payload, SECRET, old);
    expect(verifyStripeSignature(Buffer.from(payload), header, SECRET)).toBe(false);
  });

  it("rejects missing or malformed headers", () => {
    const payload = Buffer.from("{}");
    expect(verifyStripeSignature(payload, undefined, SECRET)).toBe(false);
    expect(verifyStripeSignature(payload, "garbage", SECRET)).toBe(false);
    expect(verifyStripeSignature(payload, "t=12345", SECRET)).toBe(false);
  });
});
