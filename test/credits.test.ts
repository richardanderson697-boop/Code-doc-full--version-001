// Credit metering math and ledger behavior.
import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import { getDb, initStore } from "../server/store";
import {
  creditsForUsage,
  extractUsage,
  spendCredits,
  addCredits,
  getBalance,
} from "../server/credits";
import { PRIMARY_MODEL, FALLBACK_MODEL } from "../server/gemini";

async function makeUser(credits: number): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().run(
    "INSERT INTO users (id, email, password_hash, password_salt, credits_balance, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, `${id}@x.io`, "h", "s", credits, new Date().toISOString()]
  );
  return id;
}

beforeAll(async () => {
  await initStore();
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
  it("spends and reports the new balance", async () => {
    const id = await makeUser(100);
    expect(await spendCredits(id, 30, "test")).toBe(70);
    expect(await getBalance(id)).toBe(70);
  });

  it("refuses to overspend and leaves the balance untouched", async () => {
    const id = await makeUser(10);
    expect(await spendCredits(id, 11, "test")).toBeNull();
    expect(await getBalance(id)).toBe(10);
  });

  it("adds credits and records the transaction", async () => {
    const id = await makeUser(0);
    expect(await addCredits(id, 400, "credit pack: starter", "stripe:evt_1")).toBe(400);
    const row = await getDb().get<any>(
      "SELECT delta, reason, ref FROM credit_transactions WHERE user_id = $1",
      [id]
    );
    expect(row!.delta).toBe(400);
    expect(row!.ref).toBe("stripe:evt_1");
  });

  it("is idempotent on webhook retries with the same event ref", async () => {
    const id = await makeUser(0);
    await addCredits(id, 400, "credit pack", "stripe:evt_dup");
    expect(await addCredits(id, 400, "credit pack", "stripe:evt_dup")).toBe(400); // not 800
    expect(await getBalance(id)).toBe(400);
  });
});
