// Credit metering for Gemini usage.
// 1 credit = $0.01 of API cost. Rates mirror server/gemini.ts models.
import { getDb, type PendingCreditRow } from "./store";
import { log } from "./logger";
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

export async function getBalance(userId: string): Promise<number> {
  const row = await getDb().get<{ credits_balance: number }>(
    "SELECT credits_balance FROM users WHERE id = $1",
    [userId]
  );
  return row ? row.credits_balance : 0;
}

// Atomically deduct credits; returns the new balance, or null when the
// balance is too low. Balance is clamped at zero on the way out.
export async function spendCredits(
  userId: string,
  amount: number,
  reason: string,
  ref?: string
): Promise<number | null> {
  if (amount <= 0) return getBalance(userId);
  const db = getDb();
  const result = await db.run(
    "UPDATE users SET credits_balance = credits_balance - $1 WHERE id = $2 AND credits_balance >= $3",
    [amount, userId, amount]
  );
  if (result.changes === 0) return null;
  await db.run(
    "INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES ($1, $2, $3, $4, $5)",
    [userId, -amount, reason, ref ?? null, new Date().toISOString()]
  );
  return getBalance(userId);
}

/** True when the error is a unique-violation on either backend (idempotent retry). */
function isUniqueViolation(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string };
  if (anyErr?.code === "23505") return true; // Postgres
  return String(anyErr?.message ?? err).includes("UNIQUE constraint failed"); // SQLite
}

export async function addCredits(
  userId: string,
  amount: number,
  reason: string,
  ref?: string
): Promise<number | null> {
  if (amount <= 0) return null;
  const db = getDb();
  try {
    await db.transaction(async (tx) => {
      await tx.run("UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2", [
        amount,
        userId,
      ]);
      await tx.run(
        "INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES ($1, $2, $3, $4, $5)",
        [userId, amount, reason, ref ?? null, new Date().toISOString()]
      );
    });
  } catch (err: unknown) {
    // UNIQUE constraint on ref => this event was already processed (idempotent webhook retry).
    if (isUniqueViolation(err)) return getBalance(userId);
    throw err;
  }
  return getBalance(userId);
}
// Credits parked by the Stripe webhook when the paying user was missing
// (e.g. the database was replaced between checkout and webhook delivery).
// Called on signup and login: any parked credits for the email are moved onto
// the account, so money is never silently lost. Returns the credits claimed.
export async function claimPendingCredits(userId: string, email: string): Promise<number> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) return 0;
  const db = getDb();
  const rows = await db.all<PendingCreditRow>(
    "SELECT id, credits, pack_id, stripe_event_id FROM pending_credits WHERE email = $1",
    [cleanEmail]
  );
  let claimed = 0;
  for (const row of rows) {
    try {
      const ref = `pending:${row.stripe_event_id ?? `row-${row.id}`}`;
      const balance = await addCredits(
        userId,
        row.credits,
        `claimed pending credit pack${row.pack_id ? `: ${row.pack_id}` : ""}`,
        ref
      );
      if (balance !== null) {
        await db.run("DELETE FROM pending_credits WHERE id = $1", [row.id]);
        claimed += row.credits;
      }
    } catch (err) {
      log.error(`Failed to claim pending credits row ${row.id} for ${cleanEmail}:`, err);
    }
  }
  if (claimed > 0) log.info(`Claimed ${claimed} pending credits for ${cleanEmail}`);
  return claimed;
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
export async function chargeForCall(
  userId: string,
  usage: TokenUsage,
  modelName: string | undefined,
  reason: string
): Promise<number | null> {
  const credits = creditsForUsage(usage, modelName);
  return spendCredits(userId, credits, reason);
}
