// FinalRead re-scan entitlements + the versioned review model.
//
// A $199 FinalRead Review buys one complete review plus 2 re-scans: after
// the seller's developer modifies the code to fix findings, the buyer
// triggers a re-run on the new version, twice. The re-scans are
// entitlements, separate from the 400-credit balance — they are never
// converted to credits and never refunded as credits.
//
// - Entitlements are granted at webhook time, idempotent on the Stripe
//   event id (same rule as addCredits). They expire 90 days after purchase.
// - The review is the overall diligence engagement (one per project, one
//   buyer per project for the pilot). A review has immutable VERSION rows:
//   one per code snapshot. A re-scan creates a NEW version row; it never
//   overwrites the previous one (the old updateReviewVersionHash call is
//   removed — see the seller project-saving spec, Revision 2, §6.4).
// - The legacy `finalread_review_versions` table (frozen-version record:
//   id + user_id + purchase + content_hash) is repurposed by the schema
//   migration (server/finalread-projects.ts): its rows become
//   `finalread_reviews` rows, and their content_hash becomes the initial
//   version row's hash. The versions table is recreated with the version
//   schema below.
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

/** The overall diligence engagement: one per project (one buyer per project for the pilot). */
export interface FinalReadReviewRow {
  id: string;
  project_id: string | null;
  seller_user_id: string;
  purchase_stripe_event_id: string | null;
  /** DEPRECATED: kept for the legacy migration only. New reviews store NULL here; the hash lives on the version rows. */
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

/** ONE immutable assessment of a particular code snapshot. Never updated. */
export interface ReviewVersionRow {
  id: string;
  review_id: string;
  project_id: string | null;
  version_number: number;
  content_hash: string;
  audit_snapshot_id: string | null;
  stripe_event_id: string | null;
  created_at: string;
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

/**
 * Create a review (the engagement) with its first version row. Used by the
 * entry flow (no project): the caller is the buyer, the review is created
 * from their scan, and the version row carries the scanned hash. The
 * project flow creates its review the same way at the initial scan (via
 * createFinalReadReview below, with a project id); the version row for a
 * project review is created at payment time instead (see
 * server/finalread-projects.ts), so this function is the entry-flow path.
 */
export async function createFinalReadReview(opts: {
  sellerUserId: string;
  projectId?: string | null;
  purchaseStripeEventId?: string | null;
  contentHash: string;
  stripeEventId?: string | null;
}): Promise<{ review: FinalReadReviewRow; version: ReviewVersionRow }> {
  const db = getDb();
  const reviewId = `frv_${crypto.randomUUID()}`;
  const versionId = `frvv_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO finalread_reviews (id, project_id, seller_user_id, purchase_stripe_event_id, content_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [
      reviewId,
      opts.projectId ?? null,
      opts.sellerUserId,
      opts.purchaseStripeEventId ?? null,
      null,
      now,
      now,
    ]
  );
  await db.run(
    "INSERT INTO finalread_review_versions (id, review_id, project_id, version_number, content_hash, audit_snapshot_id, stripe_event_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      versionId,
      reviewId,
      opts.projectId ?? null,
      1,
      opts.contentHash,
      null,
      opts.stripeEventId ?? opts.purchaseStripeEventId ?? null,
      now,
    ]
  );
  const review = await db.get<FinalReadReviewRow>(
    "SELECT * FROM finalread_reviews WHERE id = $1",
    [reviewId]
  );
  const version = await db.get<ReviewVersionRow>(
    "SELECT * FROM finalread_review_versions WHERE id = $1",
    [versionId]
  );
  if (!review || !version) throw new Error("Failed to create FinalRead review");
  return { review, version };
}

/** Create one immutable version row for an existing review. */
export async function createReviewVersionRow(opts: {
  reviewId: string;
  projectId?: string | null;
  versionNumber: number;
  contentHash: string;
  auditSnapshotId?: string | null;
  stripeEventId?: string | null;
}): Promise<ReviewVersionRow> {
  const db = getDb();
  const id = `frvv_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO finalread_review_versions (id, review_id, project_id, version_number, content_hash, audit_snapshot_id, stripe_event_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      id,
      opts.reviewId,
      opts.projectId ?? null,
      opts.versionNumber,
      opts.contentHash,
      opts.auditSnapshotId ?? null,
      opts.stripeEventId ?? null,
      now,
    ]
  );
  const row = await db.get<ReviewVersionRow>(
    "SELECT * FROM finalread_review_versions WHERE id = $1",
    [id]
  );
  if (!row) throw new Error("Failed to create review version");
  return row;
}

/** A version row by its id. */
export async function getReviewVersion(id: string): Promise<ReviewVersionRow | undefined> {
  return getDb().get<ReviewVersionRow>(
    "SELECT * FROM finalread_review_versions WHERE id = $1",
    [id]
  );
}

/** All versions of a review, oldest first. */
export async function getReviewVersions(reviewId: string): Promise<ReviewVersionRow[]> {
  return getDb().all<ReviewVersionRow>(
    "SELECT * FROM finalread_review_versions WHERE review_id = $1 ORDER BY version_number ASC, created_at ASC",
    [reviewId]
  );
}

/** The latest version of a review (the current frozen version), if any. */
export async function getLatestReviewVersion(
  reviewId: string
): Promise<ReviewVersionRow | undefined> {
  return getDb().get<ReviewVersionRow>(
    "SELECT * FROM finalread_review_versions WHERE review_id = $1 ORDER BY version_number DESC, created_at DESC LIMIT 1",
    [reviewId]
  );
}

/**
 * A review with its latest version. Returns undefined when the review does
 * not exist; version is undefined when the review has no version row yet
 * (a project review whose report has not been generated — the missing-audit
 * edge case).
 */
export async function getFinalReadReview(
  reviewId: string
): Promise<
  | { review: FinalReadReviewRow; version: ReviewVersionRow | undefined }
  | undefined
> {
  const review = await getDb().get<FinalReadReviewRow>(
    "SELECT * FROM finalread_reviews WHERE id = $1",
    [reviewId]
  );
  if (!review) return undefined;
  const version = await getLatestReviewVersion(reviewId);
  return { review, version };
}
