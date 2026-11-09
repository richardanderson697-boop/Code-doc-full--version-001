// FinalRead re-scan entitlements + the minimal frozen-version record.
//
// A $199 FinalRead Review buys one complete review plus 2 re-scans: after
// the seller's developer modifies the code to fix findings, the buyer
// triggers a re-run on the new version, twice. The re-scans are
// entitlements, separate from the 400-credit balance — they are never
// converted to credits and never refunded as credits.
//
// - Entitlements are granted at webhook time, idempotent on the Stripe
//   event id (same rule as addCredits). They expire 90 days after purchase.
// - The frozen version is the minimal pinned-version record the billing
//   spec defines (version id + content hash + buyer + purchase). It is NOT
//   the full transaction workflow: no invite links, no report-entry codes,
//   no seller responses, no remediation loop. A scan of a frozen review
//   compares the scanned files' content hash against the frozen hash:
//   identical code is not a re-scan (no charge, no consumption), changed
//   code is.
import crypto from "crypto";
import { getDb } from "./store";

/** Re-scans included in one $199 FinalRead Review (bundle sheet, X=2). */
export const FINALREAD_RESCAN_COUNT = 2;
/** Entitlements expire this long after purchase (bundle sheet, 90 days). */
export const FINALREAD_RESCAN_EXPIRY_DAYS = 90;
/** The pack whose purchase grants re-scan entitlements. */
export const FINALREAD_RESCAN_PACK_ID = "finalread";

export interface RescanEntitlementRow {
  id: number;
  user_id: string;
  stripe_event_id: string;
  pack_id: string;
  remaining: number;
  purchased_at: string;
  expires_at: string;
}

export interface ReviewVersionRow {
  id: string;
  user_id: string;
  purchase_stripe_event_id: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

function expiryFor(purchasedAt: Date): Date {
  return new Date(purchasedAt.getTime() + FINALREAD_RESCAN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Grant the bundle's re-scan entitlements for a $199 purchase. Idempotent
 * on the Stripe event id: a webhook retry returns the existing row without
 * adding a second grant. Returns the entitlement row.
 */
export async function grantRescanEntitlements(
  userId: string,
  packId: string,
  stripeEventId: string,
  purchasedAt: Date
): Promise<RescanEntitlementRow> {
  const db = getDb();
  const expiresAt = expiryFor(purchasedAt);
  // SQLite and Postgres spell idempotent inserts differently (same pattern
  // as the pending_credits park in the billing webhook).
  const sql =
    db.dialect === "postgres"
      ? "INSERT INTO finalread_rescan_entitlements (user_id, stripe_event_id, pack_id, remaining, purchased_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (stripe_event_id) DO NOTHING"
      : "INSERT OR IGNORE INTO finalread_rescan_entitlements (user_id, stripe_event_id, pack_id, remaining, purchased_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)";
  await db.run(sql, [
    userId,
    stripeEventId,
    packId,
    FINALREAD_RESCAN_COUNT,
    purchasedAt.toISOString(),
    expiresAt.toISOString(),
  ]);
  const row = await db.get<RescanEntitlementRow>(
    "SELECT * FROM finalread_rescan_entitlements WHERE stripe_event_id = $1",
    [stripeEventId]
  );
  if (!row) throw new Error("Failed to grant re-scan entitlements");
  return row;
}

/**
 * The buyer's earliest-expiring usable entitlement: remaining > 0 and not
 * yet expired. Returns undefined when the buyer has none — the caller then
 * falls back to the normal metered credit charge.
 */
export async function findUsableEntitlement(
  userId: string,
  now: Date = new Date()
): Promise<RescanEntitlementRow | undefined> {
  return getDb().get<RescanEntitlementRow>(
    "SELECT * FROM finalread_rescan_entitlements WHERE user_id = $1 AND remaining > 0 AND expires_at > $2 ORDER BY expires_at ASC LIMIT 1",
    [userId, now.toISOString()]
  );
}

/**
 * Atomically consume one re-scan entitlement. Returns true when one was
 * consumed, false when the row was already exhausted (a concurrent
 * re-scan won the race) — the caller then falls back to the credit charge.
 */
export async function consumeRescanEntitlement(entitlementId: number): Promise<boolean> {
  const result = await getDb().run(
    "UPDATE finalread_rescan_entitlements SET remaining = remaining - 1 WHERE id = $1 AND remaining > 0",
    [entitlementId]
  );
  return result.changes === 1;
}

/** Total unexpired re-scans remaining for the buyer, across purchases. */
export async function countRemainingEntitlements(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const row = await getDb().get<{ total: number }>(
    "SELECT COALESCE(SUM(remaining), 0) AS total FROM finalread_rescan_entitlements WHERE user_id = $1 AND expires_at > $2",
    [userId, now.toISOString()]
  );
  return row ? Number(row.total) : 0;
}

/**
 * Content hash of exactly the files a scan grades: SHA-256 over the
 * sorted (path, content) pairs, so file order never matters and any
 * content change — however small — produces a different hash.
 */
export function hashReviewContent(files: { path: string; content: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = crypto.createHash("sha256");
  for (const f of sorted) {
    hash.update(f.path);
    hash.update("\0");
    hash.update(f.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The purchase (Stripe event id) behind the buyer's latest $199 purchase, if any. */
export async function findLatestFinalReadPurchase(userId: string): Promise<string | null> {
  const row = await getDb().get<{ stripe_event_id: string }>(
    "SELECT stripe_event_id FROM finalread_rescan_entitlements WHERE user_id = $1 AND pack_id = $2 ORDER BY purchased_at DESC LIMIT 1",
    [userId, FINALREAD_RESCAN_PACK_ID]
  );
  return row ? row.stripe_event_id : null;
}

/** Create the frozen-version record for a first FinalRead review. */
export async function createReviewVersion(
  userId: string,
  purchaseStripeEventId: string | null,
  contentHash: string
): Promise<ReviewVersionRow> {
  const id = `frv_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await getDb().run(
    "INSERT INTO finalread_review_versions (id, user_id, purchase_stripe_event_id, content_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, userId, purchaseStripeEventId, contentHash, now, now]
  );
  const row = await getDb().get<ReviewVersionRow>(
    "SELECT * FROM finalread_review_versions WHERE id = $1",
    [id]
  );
  if (!row) throw new Error("Failed to create frozen review version");
  return row;
}

export async function getReviewVersion(id: string): Promise<ReviewVersionRow | undefined> {
  return getDb().get<ReviewVersionRow>("SELECT * FROM finalread_review_versions WHERE id = $1", [
    id,
  ]);
}

/** The scanned code changed: the new version becomes the frozen one. */
export async function updateReviewVersionHash(id: string, contentHash: string): Promise<void> {
  await getDb().run(
    "UPDATE finalread_review_versions SET content_hash = $1, updated_at = $2 WHERE id = $3",
    [contentHash, new Date().toISOString(), id]
  );
}
