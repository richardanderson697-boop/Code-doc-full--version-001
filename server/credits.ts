// Credit metering for Gemini usage.
// 1 credit = $0.01 of API cost. Rates mirror server/gemini.ts models.
import { getAuthDb } from "./authdb";
import { PRIMARY_MODEL, FALLBACK_MODEL } from "./gemini";

interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

const RATES: Record<string, ModelRate> = {
  [PRIMARY_MODEL]: { inputPerMillion: 1.5, outputPerMillion: 7.5 },
  [FALLBACK_MODEL]: { inputPerMillion: 0.3, outputPerMillion: 2.5 },
};

const DEFAULT_RATE: ModelRate = RATES[PRIMARY_MODEL];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// Pull token counts off a GenerateContentResponse (or a stream chunk).
export function extractUsage(response: any): TokenUsage {
  const meta = response?.usageMetadata ?? {};
  return {
    inputTokens: Number(meta.promptTokenCount ?? 0) || 0,
    outputTokens: Number(meta.candidatesTokenCount ?? 0) || 0,
  };
}

// Whole credits, always rounded up so we never under-charge.
export function creditsForUsage(usage: TokenUsage, modelName?: string): number {
  const rate = (modelName && RATES[modelName]) || DEFAULT_RATE;
  const costDollars =
    (usage.inputTokens / 1_000_000) * rate.inputPerMillion +
    (usage.outputTokens / 1_000_000) * rate.outputPerMillion;
  return Math.max(1, Math.ceil(costDollars * 100));
}

export function getBalance(userId: string): number {
  const row = getAuthDb()
    .prepare("SELECT credits_balance FROM users WHERE id = ?")
    .get(userId) as { credits_balance: number } | undefined;
  return row ? row.credits_balance : 0;
}

// Atomically deduct credits; returns the new balance, or null when the
// balance is too low. Balance is clamped at zero on the way out.
export function spendCredits(userId: string, amount: number, reason: string, ref?: string): number | null {
  if (amount <= 0) return getBalance(userId);
  const db = getAuthDb();
  const deduct = db.prepare(
    "UPDATE users SET credits_balance = credits_balance - ? WHERE id = ? AND credits_balance >= ?"
  );
  const result = deduct.run(amount, userId, amount);
  if (result.changes === 0) return null;
  db.prepare(
    "INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, -amount, reason, ref ?? null, new Date().toISOString());
  return getBalance(userId);
}

export function addCredits(userId: string, amount: number, reason: string, ref?: string): number | null {
  if (amount <= 0) return null;
  const db = getAuthDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET credits_balance = credits_balance + ? WHERE id = ?").run(amount, userId);
    db.prepare(
      "INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(userId, amount, reason, ref ?? null, new Date().toISOString());
    db.exec("COMMIT");
  } catch (err: any) {
    try { db.exec("ROLLBACK"); } catch { /* noop */ }
    // UNIQUE constraint on ref => this event was already processed (idempotent webhook retry).
    if (String(err?.message ?? err).includes("UNIQUE constraint failed")) return getBalance(userId);
    throw err;
  }
  return getBalance(userId);
}

// Minimum balance required BEFORE an AI call starts. We can't know the exact
// cost up front, so each endpoint declares a ceiling-ish minimum and we meter
// the true cost afterwards.
export const MIN_CREDITS = {
  heal: 5, // quick debugger chat
  audit: 15, // single-file audit (two model passes)
  coldAudit: 15,
  intelligence: 40, // full workspace scan, scales with project size
  generate: 25, // SSE code generation
  workspaceFile: 15,
} as const;

export type CreditTier = keyof typeof MIN_CREDITS;

// Deduct the metered cost of one Gemini call. Returns the new balance.
export function chargeForCall(
  userId: string,
  usage: TokenUsage,
  modelName: string | undefined,
  reason: string
): number | null {
  const credits = creditsForUsage(usage, modelName);
  return spendCredits(userId, credits, reason);
}
