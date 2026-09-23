// Credit metering math and ledger behavior.
import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import { getAuthDb, initAuthStore } from "../server/authdb";
import {
  creditsForUsage,
  extractUsage,
  spendCredits,
  addCredits,
  getBalance,
} from "../server/credits";
import { PRIMARY_MODEL, FALLBACK_MODEL } from "../server/gemini";

function makeUser(credits: number): string {
  const id = crypto.randomUUID();
  getAuthDb()
    .prepare("INSERT INTO users (id, email, password_hash, password_salt, credits_balance, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, `${id}@x.io`, "h", "s", credits, new Date().toISOString());
  return id;
}

beforeAll(() => {
  initAuthStore();
});

describe("creditsForUsage", () => {
  it("charges primary-model rates: 1M in + 1M out = $9 = 900 credits", () => {
    expect(creditsForUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, PRIMARY_MODEL)).toBe(900);
  });

  it("charges fallback rates ~5x cheaper", () => {
    const primary = creditsForUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, PRIMARY_MODEL);
    const lite = creditsForUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, FALLBACK_MODEL);
    expect(lite).toBeLessThan(primary);
    expect(lite).toBe(280); // 0.30 + 2.50 = $2.80
  });

  it("rounds up to at least 1 credit and never under-charges fractions", () => {
    expect(creditsForUsage({ inputTokens: 10, outputTokens: 10 }, PRIMARY_MODEL)).toBe(1);
    // $0.0151 -> 2 credits, not 1
    expect(creditsForUsage({ inputTokens: 10_000, outputTokens: 10 }, PRIMARY_MODEL)).toBe(2);
  });

  it("extractUsage tolerates missing metadata", () => {
    expect(extractUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(extractUsage({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 } })).toEqual({
      inputTokens: 5,
      outputTokens: 7,
    });
  });
});

describe("ledger", () => {
  it("spends and reports the new balance", () => {
    const id = makeUser(100);
    expect(spendCredits(id, 30, "test")).toBe(70);
    expect(getBalance(id)).toBe(70);
  });

  it("refuses to overspend and leaves the balance untouched", () => {
    const id = makeUser(10);
    expect(spendCredits(id, 11, "test")).toBeNull();
    expect(getBalance(id)).toBe(10);
  });

  it("adds credits and records the transaction", () => {
    const id = makeUser(0);
    expect(addCredits(id, 400, "credit pack: starter", "stripe:evt_1")).toBe(400);
    const row = getAuthDb()
      .prepare("SELECT delta, reason, ref FROM credit_transactions WHERE user_id = ?")
      .get(id) as any;
    expect(row.delta).toBe(400);
    expect(row.ref).toBe("stripe:evt_1");
  });

  it("is idempotent on webhook retries with the same event ref", () => {
    const id = makeUser(0);
    addCredits(id, 400, "credit pack", "stripe:evt_dup");
    expect(addCredits(id, 400, "credit pack", "stripe:evt_dup")).toBe(400); // not 800
    expect(getBalance(id)).toBe(400);
  });
});
