// FinalRead two-sided flow: the versioned transaction model.
//
// Implements finalread-two-sided-flow-spec.md (Revision 3, APPROVED
// 2026-11-20; one-code decision CONFIRMED 2026-11-21). The store-level
// helpers for the eight versioned tables plus the buyer-initiated
// REVIEW-REQUEST lifecycle, the pending-audit report generation, the
// atomic activation, the losing-payment refund record, and the
// missing-audit report job.
//
// The flow (spec §2-§4): the buyer creates a review request and its
// 8-character code; the seller saves a project against that code (the
// bind); the seller scans (free, only when bound); the buyer enters the
// SAME code to pay $199; the webhook activates the request FIRST, then
// grants credits + entitlements. A losing payment (activation fails) is
// refunded and grants NOTHING.
//
// Rules this module enforces (the spec's, not the caller's):
// - The buyer never receives source code, workspace files, or the project
//   record. Buyer access is scoped to ONE report (and its Q&A) only.
// - The audit is stored by the SERVER from a server-run scan, never from a
//   client-supplied audit. A client-supplied audit is never read.
// - A re-scan's source is always the seller's saved project, resolved
//   server-side from the project id. Client-supplied paths/codeFiles are
//   never a re-scan source.
// - Versions are immutable: a re-scan creates a NEW version row, never an
//   update. The only mutable field on an audit snapshot is its status
//   (pending -> active, once, at payment) plus the version link set at
//   the same moment; the audit JSON and content hash never change.
// - Grant amounts live in server code (getPacks), never in Stripe metadata.
// - Nothing here commits, pushes, or deploys. It only writes rows.
//
// Naming note: the legacy tables/columns keep their `invite_code_id`
// names (values now hold review-request ids); only the Stripe metadata
// key was renamed inviteCodeId -> requestCodeId (spec §4d). Renaming the
// DB columns was rejected as migration risk the spec does not require.
import crypto from "crypto";
import { getDb, type Db } from "./store";
import { log } from "./logger";
import {
  createReviewVersionRow,
  findLatestFinalReadPurchase,
  getLatestReviewVersion,
  hashReviewContent,
  type FinalReadReviewRow,
  type ReviewVersionRow,
} from "./finalread-rescans";
import { buildFinalReadReport, stripLedgerSourceText } from "../shared/finalread-report";
import { listWorkspaceFiles } from "./workspace-store";
import { createStripeRefund } from "./stripe-client";
import { sendFinalReadRefundEmail } from "./email";

export type { FinalReadReviewRow, ReviewVersionRow };

export interface FinalReadProjectRow {
  id: string;
  seller_user_id: string;
  title: string;
  finalread_review_id: string | null;
  purchase_stripe_event_id: string | null;
  /** Id of the bound buyer review request (two-sided flow §4b). */
  request_id: string | null;
  /** ISO timestamp of a scan currently running for this project (§4c). */
  scan_in_progress_at: string | null;
  status: "draft" | "active" | "closed";
  created_at: string;
  updated_at: string;
}

/**
 * A buyer-initiated review request (two-sided flow §4a). The buyer
 * creates it and its 8-character code; the seller binds a project to it.
 * One code flows buyer -> seller -> buyer.
 * status: requested -> uploaded -> reserved -> activated / expired /
 * revoked. `code_hash` is the ONLY stored form of the code.
 */
export interface ReviewRequestRow {
  id: string;
  buyer_user_id: string;
  title: string;
  code_hash: string;
  status: "requested" | "uploaded" | "reserved" | "activated" | "expired" | "revoked";
  project_id: string | null;
  reserved_by: string | null;
  reserved_until: string | null;
  used_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** A buyer may hold at most this many unbound (requested, unexpired) requests. */
export const MAX_UNBOUND_REVIEW_REQUESTS = 3;
/** A buyer may create at most this many requests per rolling 24h day. */
export const MAX_REVIEW_REQUESTS_PER_DAY = 5;
/** A request's code expires this long after creation (spec §4a). */
export const REVIEW_REQUEST_TTL_DAYS = 30;
/** A scan-in-progress marker older than this is stale and may be retaken (§4c). */
export const SCAN_GUARD_STALE_MINUTES = 30;

export class ReviewRequestRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRequestRateLimitedError";
  }
}

export interface AuditSnapshotRow {
  id: string;
  version_id: string | null;
  review_id: string;
  audit: string;
  content_hash: string;
  status: "pending" | "active";
  created_at: string;
}

export interface FinalReadReportRow {
  id: string;
  version_id: string;
  review_id: string;
  report: string;
  created_at: string;
}

export interface BuyerAccessRow {
  id: string;
  buyer_user_id: string;
  project_id: string;
  review_id: string;
  invite_code_id: string;
  stripe_event_id: string;
  activated_at: string;
  created_at: string;
}

/**
 * Legacy seller-issued invite code (Revision 2, SUPERSEDED by the
 * two-sided flow §4a — no route reads or writes this table after the
 * Rev 3 build). Kept because the table still exists in the schema for
 * pre-Rev3 rows. Buyer access / refund / pending-activation rows keep
 * their `invite_code_id` column names; the values now hold
 * review-request ids.
 */
export interface InviteCodeRow {
  id: string;
  project_id: string;
  code_hash: string;
  status: "issued" | "reserved" | "activated" | "expired" | "revoked";
  reserved_by: string | null;
  reserved_until: string | null;
  used_at: string | null;
  buyer_user_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface QaHistoryRow {
  id: number;
  version_id: string;
  review_id: string;
  buyer_user_id: string;
  question: string;
  answer: string;
  cited_findings: string;
  created_at: string;
}

export interface RefundRecordRow {
  id: number;
  stripe_event_id: string;
  invite_code_id: string | null;
  project_id: string | null;
  buyer_user_id: string;
  payment_intent: string | null;
  refund_id: string | null;
  status: "refunded" | "failed";
  error: string | null;
  created_at: string;
}

export interface PendingActivationRow {
  id: number;
  stripe_event_id: string;
  invite_code_id: string;
  project_id: string;
  email: string;
  /** Stored so a failed activation at claim time can still refund. */
  payment_intent: string | null;
  created_at: string;
}

export interface ReportJobRow {
  id: number;
  review_id: string;
  stripe_event_id: string | null;
  status: "pending" | "done" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Parse a JSON column: Postgres returns JSONB as an object already, SQLite returns the stored string. */
export function parseJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

// ---- Schema migration: legacy frozen-version table -> reviews + versions ----

/**
 * The legacy `finalread_review_versions` table (frozen-version record: id +
 * user_id + purchase + content_hash) is repurposed by the versioned model:
 * its rows become `finalread_reviews` rows, and their content_hash becomes
 * the initial version row's hash (spec §6.4).
 *
 * Runs in two steps around the SCHEMA creation in initSchema:
 * - before: rename the legacy table to finalread_reviews, rename user_id to
 *   seller_user_id, add project_id. (After this the SCHEMA's CREATE TABLE
 *   IF NOT EXISTS finalread_review_versions creates the NEW versions table.)
 * - after: insert a version-1 row for every migrated review that has a
 *   frozen hash but no version row yet. Idempotent: reviews that already
 *   have a version row are skipped. The deprecated content_hash column on
 *   finalread_reviews is the migration marker (new reviews store NULL).
 */
async function legacyReviewVersionsColumns(db: Db): Promise<Set<string> | null> {
  if (db.dialect === "postgres") {
    const rows = await db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
      ["finalread_review_versions"]
    );
    if (rows.length === 0) return null;
    return new Set(rows.map((r) => r.column_name));
  }
  const rows = await db.all<{ name: string }>("PRAGMA table_info(finalread_review_versions)");
  if (rows.length === 0) return null;
  return new Set(rows.map((r) => r.name));
}

export async function migrateFinalReadSchemaBefore(db: Db): Promise<void> {
  const columns = await legacyReviewVersionsColumns(db);
  if (columns === null) return; // no table yet (fresh install)
  if (columns.has("review_id")) return; // already the new version shape
  // Legacy shape: repurpose as finalread_reviews.
  await db.transaction(async (tx) => {
    await tx.exec("ALTER TABLE finalread_review_versions RENAME TO finalread_reviews");
    await tx.exec("ALTER TABLE finalread_reviews RENAME COLUMN user_id TO seller_user_id");
    await tx.exec("ALTER TABLE finalread_reviews ADD COLUMN project_id TEXT");
  });
  log.info("Migrated legacy finalread_review_versions table to finalread_reviews");
}

export async function migrateFinalReadSchemaAfter(db: Db): Promise<void> {
  const rows = await db.all<{
    id: string;
    purchase_stripe_event_id: string | null;
    content_hash: string;
    created_at: string;
  }>(
    "SELECT id, purchase_stripe_event_id, content_hash, created_at FROM finalread_reviews WHERE content_hash IS NOT NULL AND id NOT IN (SELECT review_id FROM finalread_review_versions)"
  );
  for (const row of rows) {
    await db.run(
      "INSERT INTO finalread_review_versions (id, review_id, project_id, version_number, content_hash, audit_snapshot_id, stripe_event_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        `frvv_${crypto.randomUUID()}`,
        row.id,
        null,
        1,
        row.content_hash,
        null,
        row.purchase_stripe_event_id,
        row.created_at,
      ]
    );
  }
  if (rows.length > 0) {
    log.info(`Migrated ${rows.length} legacy frozen version(s) to version rows`);
  }
}

/**
 * Two-sided flow spec Rev 3 (§4b, §4c): the project row gains the bound
 * request id and the DB-backed scan-in-progress marker. CREATE TABLE IF
 * NOT EXISTS cannot add columns to an existing table, so this runs after
 * the SCHEMA in initSchema and adds them only when missing (idempotent —
 * fresh installs already have them from the SCHEMA).
 */
export async function migrateFinalReadProjectColumns(db: Db): Promise<void> {
  let columns: Set<string> | null;
  if (db.dialect === "postgres") {
    const rows = await db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
      ["finalread_projects"]
    );
    if (rows.length === 0) return; // table does not exist yet
    columns = new Set(rows.map((r) => r.column_name));
  } else {
    const rows = await db.all<{ name: string }>("PRAGMA table_info(finalread_projects)");
    if (rows.length === 0) return;
    columns = new Set(rows.map((r) => r.name));
  }
  if (!columns.has("request_id")) {
    await db.exec("ALTER TABLE finalread_projects ADD COLUMN request_id TEXT");
  }
  if (!columns.has("scan_in_progress_at")) {
    await db.exec(
      db.dialect === "postgres"
        ? "ALTER TABLE finalread_projects ADD COLUMN scan_in_progress_at TIMESTAMPTZ"
        : "ALTER TABLE finalread_projects ADD COLUMN scan_in_progress_at TEXT"
    );
  }
}

// ---- Projects (seller-owned, owner-scoped, 404 cross-user) ----

/**
 * Seller save with a request code (two-sided flow §4b): the ATOMIC
 * BIND. One conditional UPDATE claims the request — status requested,
 * unexpired, and the buyer is not the seller (the bind-time identity
 * rule) — and the project row is created bound to it in the same
 * transaction. Exactly one row must change; a second seller racing for
 * the same code loses (0 rows) and gets the generic "isn't valid"
 * answer, so a code can never be claimed twice. A save WITHOUT a valid
 * request code is rejected — there is no codeless project path in the
 * two-sided flow, so createFinalReadProject is gone. Returns null when
 * the code is missing, unknown, expired, already bound, or belongs to
 * the seller.
 */
export async function createProjectWithRequest(
  sellerUserId: string,
  title: string,
  requestCode: string
): Promise<FinalReadProjectRow | null> {
  const db = getDb();
  const request = await findReviewRequestByHash(hashInviteCode(requestCode));
  if (!request) return null;
  const projectId = `frp_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const bound = await db.transaction(async (tx) => {
    const res = await tx.run(
      "UPDATE finalread_review_requests SET status = $1, project_id = $2, updated_at = $3 WHERE id = $4 AND status = $5 AND expires_at > $6 AND buyer_user_id != $7",
      ["uploaded", projectId, now, request.id, "requested", now, sellerUserId]
    );
    if (res.changes !== 1) return false;
    await tx.run(
      "INSERT INTO finalread_projects (id, seller_user_id, title, finalread_review_id, purchase_stripe_event_id, request_id, scan_in_progress_at, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [projectId, sellerUserId, title, null, null, request.id, null, "draft", now, now]
    );
    return true;
  });
  if (!bound) return null;
  const row = await getFinalReadProject(projectId);
  if (!row) throw new Error("Failed to create FinalRead project");
  return row;
}

/**
 * Re-bind a DRAFT project to a different request code before payment
 * (§4b): the same atomic claim as the bind, and the previously bound
 * request (if any) is revoked and detached. Re-entering the code the
 * project is already bound to is a no-op success. Blocked while the
 * bound request has an active checkout reservation — closing the deal
 * out from under a buyer mid-checkout is the same hazard the
 * close-while-reserved rule (§4i case 3) guards. A paid project is
 * 'active', not 'draft', so it can never be re-bound.
 */
export async function rebindProjectRequest(
  projectId: string,
  sellerUserId: string,
  requestCode: string
): Promise<"ok" | "not-found" | "reserved" | "invalid-code"> {
  const db = getDb();
  const project = await getFinalReadProjectForSeller(projectId, sellerUserId);
  if (!project || project.status !== "draft") return "not-found";
  const request = await findReviewRequestByHash(hashInviteCode(requestCode));
  if (!request) return "invalid-code";
  const existing = await getRequestForProject(projectId);
  if (existing && existing.id === request.id) return "ok";
  if (
    existing &&
    existing.status === "reserved" &&
    existing.reserved_until &&
    new Date(existing.reserved_until) > new Date()
  ) {
    return "reserved";
  }
  const now = new Date().toISOString();
  const bound = await db.transaction(async (tx) => {
    const res = await tx.run(
      "UPDATE finalread_review_requests SET status = $1, project_id = $2, updated_at = $3 WHERE id = $4 AND status = $5 AND expires_at > $6 AND buyer_user_id != $7",
      ["uploaded", projectId, now, request.id, "requested", now, sellerUserId]
    );
    if (res.changes !== 1) return false;
    if (existing) {
      await tx.run(
        "UPDATE finalread_review_requests SET status = $1, project_id = $2, updated_at = $3 WHERE id = $4",
        ["revoked", null, now, existing.id]
      );
    }
    await tx.run(
      "UPDATE finalread_projects SET request_id = $1, updated_at = $2 WHERE id = $3",
      [request.id, now, projectId]
    );
    return true;
  });
  return bound ? "ok" : "invalid-code";
}

export async function getFinalReadProject(
  id: string
): Promise<FinalReadProjectRow | undefined> {
  return getDb().get<FinalReadProjectRow>(
    "SELECT * FROM finalread_projects WHERE id = $1",
    [id]
  );
}

/** Owner-scoped fetch: another seller's project behaves like a nonexistent one. */
export async function getFinalReadProjectForSeller(
  id: string,
  sellerUserId: string
): Promise<FinalReadProjectRow | undefined> {
  return getDb().get<FinalReadProjectRow>(
    "SELECT * FROM finalread_projects WHERE id = $1 AND seller_user_id = $2",
    [id, sellerUserId]
  );
}

/**
 * Create the review (engagement) for a project's initial scan. Unlike
 * createFinalReadReview (the entry flow), this creates NO version row:
 * version 1 is created at payment time from the pending audit snapshot
 * (generateReportFromPendingAudit). The review's content_hash stays NULL
 * (the deprecated column is the migration marker — new reviews store NULL).
 */
export async function createProjectReview(
  projectId: string,
  sellerUserId: string
): Promise<FinalReadReviewRow> {
  const db = getDb();
  const id = `frv_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO finalread_reviews (id, project_id, seller_user_id, purchase_stripe_event_id, content_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, projectId, sellerUserId, null, null, now, now]
  );
  const row = await db.get<FinalReadReviewRow>(
    "SELECT * FROM finalread_reviews WHERE id = $1",
    [id]
  );
  if (!row) throw new Error("Failed to create FinalRead review");
  return row;
}

/**
 * Create the review (engagement) for an entry-flow scan (stakeholder-view
 * gate spec §5): the caller uploaded the code themselves, so the review
 * has NO project. Like createProjectReview, this creates NO version row:
 * version 1 is created at payment time from the pending audit snapshot
 * (generateReportFromPendingAudit, via generateReportForPaidEntryReview).
 * The scan stores the pending audit keyed by this review id, so the
 * report can be generated at payment without a second scan. The purchase
 * event, when the caller already holds a $199 purchase, is recorded from
 * creation (the same link createFinalReadReview made); a purchase that
 * lands after the scan is claimed at the first paid report fetch instead.
 */
export async function createEntryReview(
  sellerUserId: string,
  purchaseStripeEventId?: string | null
): Promise<FinalReadReviewRow> {
  const db = getDb();
  const id = `frv_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO finalread_reviews (id, project_id, seller_user_id, purchase_stripe_event_id, content_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, null, sellerUserId, purchaseStripeEventId ?? null, null, now, now]
  );
  const row = await db.get<FinalReadReviewRow>(
    "SELECT * FROM finalread_reviews WHERE id = $1",
    [id]
  );
  if (!row) throw new Error("Failed to create FinalRead review");
  return row;
}

export async function listFinalReadProjects(
  sellerUserId: string
): Promise<FinalReadProjectRow[]> {
  return getDb().all<FinalReadProjectRow>(
    "SELECT * FROM finalread_projects WHERE seller_user_id = $1 ORDER BY created_at DESC",
    [sellerUserId]
  );
}

export async function setProjectReview(
  projectId: string,
  reviewId: string
): Promise<void> {
  await getDb().run(
    "UPDATE finalread_projects SET finalread_review_id = $1, updated_at = $2 WHERE id = $3",
    [reviewId, new Date().toISOString(), projectId]
  );
}

export async function setProjectActive(
  db: Db,
  projectId: string,
  stripeEventId: string
): Promise<void> {
  await db.run(
    "UPDATE finalread_projects SET status = $1, purchase_stripe_event_id = $2, updated_at = $3 WHERE id = $4",
    ["active", stripeEventId, new Date().toISOString(), projectId]
  );
}

// ---- Scan-in-progress guard (two-sided flow §4c, §4i case 5) ----

/**
 * Try to claim the scan guard for a project: a conditional UPDATE sets
 * scan_in_progress_at only when no scan is running or the marker is
 * stale (older than SCAN_GUARD_STALE_MINUTES). Returns true when this
 * caller holds the guard. A second scan while one runs gets false (the
 * route answers 409) and the first scan's pending audit stays intact.
 */
export async function tryAcquireScanGuard(projectId: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - SCAN_GUARD_STALE_MINUTES * 60 * 1000);
  const result = await db.run(
    "UPDATE finalread_projects SET scan_in_progress_at = $1 WHERE id = $2 AND (scan_in_progress_at IS NULL OR scan_in_progress_at < $3)",
    [now.toISOString(), projectId, staleBefore.toISOString()]
  );
  return result.changes === 1;
}

/** Release the scan guard (called on scan completion AND failure). */
export async function releaseScanGuard(projectId: string): Promise<void> {
  await getDb().run(
    "UPDATE finalread_projects SET scan_in_progress_at = $1 WHERE id = $2",
    [null, projectId]
  );
}

/**
 * Close (soft-delete) a project: status -> closed, hidden from the seller's
 * active list. The project row and every paid record survive closure (the
 * buyer keeps the report, the Q&A history, and the audit snapshots). Only
 * unactivated review requests are revoked — they were never paid for.
 *
 * Close-while-reserved (§4i case 3): closing a project with an ACTIVE
 * checkout reservation returns "reserved" (the route answers 409) — the
 * buyer mid-checkout must not lose the deal. Once the reservation
 * expires, close succeeds. Returns "not-found" when the project does
 * not exist or belongs to someone else.
 */
export async function closeFinalReadProject(
  id: string,
  sellerUserId: string
): Promise<"closed" | "not-found" | "reserved"> {
  const db = getDb();
  const project = await getFinalReadProjectForSeller(id, sellerUserId);
  if (!project) return "not-found";
  const bound = await getRequestForProject(id);
  if (
    bound &&
    bound.status === "reserved" &&
    bound.reserved_until &&
    new Date(bound.reserved_until) > new Date()
  ) {
    return "reserved";
  }
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE finalread_projects SET status = $1, updated_at = $2 WHERE id = $3",
      ["closed", new Date().toISOString(), id]
    );
    await tx.run(
      "UPDATE finalread_review_requests SET status = $1, updated_at = $2 WHERE project_id = $3 AND status IN ($4, $5)",
      ["revoked", new Date().toISOString(), id, "uploaded", "reserved"]
    );
  });
  return "closed";
}

/** True when a project has an ACTIVE checkout reservation on its bound request. */
export async function projectHasActiveReservation(projectId: string): Promise<boolean> {
  const bound = await getRequestForProject(projectId);
  return (
    !!bound &&
    bound.status === "reserved" &&
    !!bound.reserved_until &&
    new Date(bound.reserved_until) > new Date()
  );
}

// ---- Audit snapshots + reports (versioned, immutable content) ----

export async function createAuditSnapshot(opts: {
  reviewId: string;
  versionId?: string | null;
  audit: unknown;
  contentHash: string;
  status: "pending" | "active";
}): Promise<AuditSnapshotRow> {
  const db = getDb();
  const id = `fras_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO finalread_audit_snapshots (id, version_id, review_id, audit, content_hash, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, opts.versionId ?? null, opts.reviewId, toJson(opts.audit), opts.contentHash, opts.status, now]
  );
  const row = await db.get<AuditSnapshotRow>(
    "SELECT * FROM finalread_audit_snapshots WHERE id = $1",
    [id]
  );
  if (!row) throw new Error("Failed to create audit snapshot");
  return row;
}

export async function getPendingAuditSnapshot(
  reviewId: string
): Promise<AuditSnapshotRow | undefined> {
  return getDb().get<AuditSnapshotRow>(
    "SELECT * FROM finalread_audit_snapshots WHERE review_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1",
    [reviewId, "pending"]
  );
}

export async function getAuditSnapshot(id: string): Promise<AuditSnapshotRow | undefined> {
  return getDb().get<AuditSnapshotRow>(
    "SELECT * FROM finalread_audit_snapshots WHERE id = $1",
    [id]
  );
}

/**
 * Delete a review's pending snapshots (an initial-scan re-run replaces
 * the pending audit: the seller has not paid yet, so the pending audit
 * is not a paid artifact and the newest scan is the pinned assessment).
 */
export async function deletePendingAuditSnapshots(reviewId: string): Promise<void> {
  await getDb().run(
    "DELETE FROM finalread_audit_snapshots WHERE review_id = $1 AND status = $2",
    [reviewId, "pending"]
  );
}

export async function createReportRow(opts: {
  versionId: string;
  reviewId: string;
  report: unknown;
}): Promise<FinalReadReportRow> {
  const db = getDb();
  const id = `frr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO finalread_reports (id, version_id, review_id, report, created_at) VALUES ($1, $2, $3, $4, $5)",
    [id, opts.versionId, opts.reviewId, toJson(opts.report), now]
  );
  const row = await db.get<FinalReadReportRow>(
    "SELECT * FROM finalread_reports WHERE id = $1",
    [id]
  );
  if (!row) throw new Error("Failed to create report row");
  return row;
}

export async function getReport(id: string): Promise<FinalReadReportRow | undefined> {
  return getDb().get<FinalReadReportRow>("SELECT * FROM finalread_reports WHERE id = $1", [id]);
}

export async function getReportForVersion(
  versionId: string
): Promise<FinalReadReportRow | undefined> {
  return getDb().get<FinalReadReportRow>(
    "SELECT * FROM finalread_reports WHERE version_id = $1 ORDER BY created_at DESC LIMIT 1",
    [versionId]
  );
}

export async function getReportsForReview(reviewId: string): Promise<FinalReadReportRow[]> {
  return getDb().all<FinalReadReportRow>(
    "SELECT * FROM finalread_reports WHERE review_id = $1 ORDER BY created_at ASC",
    [reviewId]
  );
}

export async function getLatestReportForReview(
  reviewId: string
): Promise<FinalReadReportRow | undefined> {
  return getDb().get<FinalReadReportRow>(
    "SELECT * FROM finalread_reports WHERE review_id = $1 ORDER BY created_at DESC LIMIT 1",
    [reviewId]
  );
}

// ---- Review requests (buyer-initiated codes, hash-only storage, 30-day expiry, one buyer per project) ----

/** Checkout reservation length: the Stripe session expires with it. */
export const REVIEW_REQUEST_RESERVATION_MINUTES = 30;

// 8 characters, uppercase letters + digits, unambiguous characters
// excluded (no 0/O, 1/I, L) — the same "8-character" shape the seller
// already knows from the password correction.
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 8;

export function generateInviteCode(): string {
  const bytes = crypto.randomBytes(INVITE_CODE_LENGTH);
  let code = "";
  for (const b of bytes) code += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  return code;
}

export function hashInviteCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function requestExpired(row: ReviewRequestRow, now: Date = new Date()): boolean {
  return new Date(row.expires_at).getTime() <= now.getTime();
}

function requestReservationActive(row: ReviewRequestRow, now: Date = new Date()): boolean {
  return (
    row.status === "reserved" &&
    !!row.reserved_until &&
    new Date(row.reserved_until).getTime() > now.getTime()
  );
}

/**
 * Create a review request (two-sided flow §4a). The buyer names the
 * deal; the code is shown ONCE to the buyer (the seller gets it from the
 * buyer, off-platform) and only the hash is stored. 30-day expiry.
 *
 * Rate limits (§4a), enforced inside the same transaction as the
 * insert so a concurrent double-create cannot slip past them:
 * - at most MAX_UNBOUND_REVIEW_REQUESTS unbound (requested, unexpired)
 *   requests at a time — an expired request frees its slot;
 * - at most MAX_REVIEW_REQUESTS_PER_DAY created per rolling 24h day.
 * Over either limit throws ReviewRequestRateLimitedError (the route
 * maps it to 429). Returns the plaintext code ONCE.
 */
export async function createReviewRequest(
  buyerUserId: string,
  title: string
): Promise<{ code: string; row: ReviewRequestRow }> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REVIEW_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000);
  const id = `frrq_${crypto.randomUUID()}`;
  const code = generateInviteCode();
  await db.transaction(async (tx) => {
    const unbound = await tx.get<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM finalread_review_requests WHERE buyer_user_id = $1 AND status = $2 AND expires_at > $3",
      [buyerUserId, "requested", now.toISOString()]
    );
    if (Number(unbound?.count ?? 0) >= MAX_UNBOUND_REVIEW_REQUESTS) {
      throw new ReviewRequestRateLimitedError(
        "Too many open review requests — wait for one to be used or expire"
      );
    }
    const today = await tx.get<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM finalread_review_requests WHERE buyer_user_id = $1 AND created_at > $2",
      [buyerUserId, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()]
    );
    if (Number(today?.count ?? 0) >= MAX_REVIEW_REQUESTS_PER_DAY) {
      throw new ReviewRequestRateLimitedError("Too many review requests created today");
    }
    await tx.run(
      "INSERT INTO finalread_review_requests (id, buyer_user_id, title, code_hash, status, project_id, reserved_by, reserved_until, used_at, expires_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [
        id,
        buyerUserId,
        title,
        hashInviteCode(code),
        "requested",
        null,
        null,
        null,
        null,
        expiresAt.toISOString(),
        now.toISOString(),
        now.toISOString(),
      ]
    );
  });
  const row = await db.get<ReviewRequestRow>(
    "SELECT * FROM finalread_review_requests WHERE id = $1",
    [id]
  );
  if (!row) throw new Error("Failed to create review request");
  return { code, row };
}

export async function getReviewRequest(
  id: string
): Promise<ReviewRequestRow | undefined> {
  return getDb().get<ReviewRequestRow>(
    "SELECT * FROM finalread_review_requests WHERE id = $1",
    [id]
  );
}

export async function listReviewRequests(
  buyerUserId: string
): Promise<ReviewRequestRow[]> {
  return getDb().all<ReviewRequestRow>(
    "SELECT * FROM finalread_review_requests WHERE buyer_user_id = $1 ORDER BY created_at DESC",
    [buyerUserId]
  );
}

export async function findReviewRequestByHash(
  codeHash: string
): Promise<ReviewRequestRow | undefined> {
  return getDb().get<ReviewRequestRow>(
    "SELECT * FROM finalread_review_requests WHERE code_hash = $1",
    [codeHash]
  );
}

/** The request currently bound to a project (uploaded / reserved / activated). */
export async function getRequestForProject(
  projectId: string
): Promise<ReviewRequestRow | undefined> {
  return getDb().get<ReviewRequestRow>(
    "SELECT * FROM finalread_review_requests WHERE project_id = $1 AND status IN ($2, $3, $4) ORDER BY created_at DESC LIMIT 1",
    [projectId, "uploaded", "reserved", "activated"]
  );
}

export async function projectHasActivatedBuyer(projectId: string): Promise<boolean> {
  const row = await getDb().get<{ id: string }>(
    "SELECT id FROM finalread_buyer_access WHERE project_id = $1 LIMIT 1",
    [projectId]
  );
  return !!row;
}

export interface ReviewRequestValidation {
  valid: boolean;
  /** The code is already activated for this caller — they view the report, they do not pay again. */
  activatedForCaller: boolean;
  project?: FinalReadProjectRow;
  request?: ReviewRequestRow;
  reportId?: string | null;
}

/**
 * Validate a buyer-entered code (two-sided flow §4a). Every failure
 * returns the same generic shape (valid: false) — no enumeration of
 * whether a code exists, is expired, or is already used. Valid ONLY
 * when bound to a project WITH a pending audit (a code for a project
 * with no audit would let a buyer pay for a report that cannot be
 * generated). A code reserved by ANOTHER buyer whose reservation is
 * still active is not valid here; the "already in use" message is given
 * at checkout time instead (criterion 15).
 *
 * The code is the deal key for an unactivated request: any caller
 * holding it may validate and pay (as the seller-issued codes were).
 * Once activated, only the buyer who paid may resolve it.
 */
export async function validateReviewRequestCode(
  code: string,
  callerUserId: string
): Promise<ReviewRequestValidation> {
  const row = await findReviewRequestByHash(hashInviteCode(code));
  if (!row) return { valid: false, activatedForCaller: false };
  if (row.status === "revoked") return { valid: false, activatedForCaller: false };
  if (requestExpired(row)) return { valid: false, activatedForCaller: false };
  if (row.status === "activated") {
    if (row.buyer_user_id !== callerUserId) {
      return { valid: false, activatedForCaller: false };
    }
    if (!row.project_id) return { valid: false, activatedForCaller: false };
    const project = await getFinalReadProject(row.project_id);
    if (!project || !project.finalread_review_id) {
      return { valid: false, activatedForCaller: false };
    }
    const report = await getLatestReportForReview(project.finalread_review_id);
    return {
      valid: true,
      activatedForCaller: true,
      project,
      request: row,
      reportId: report ? report.id : null,
    };
  }
  if (requestReservationActive(row) && row.reserved_by !== callerUserId) {
    return { valid: false, activatedForCaller: false };
  }
  if (!row.project_id) return { valid: false, activatedForCaller: false };
  const project = await getFinalReadProject(row.project_id);
  if (!project) return { valid: false, activatedForCaller: false };
  if (await projectHasActivatedBuyer(row.project_id)) {
    return { valid: false, activatedForCaller: false };
  }
  // No buyer request, no scan — and no payment without a report to
  // generate: the bound project must have a pending audit.
  if (!project.finalread_review_id) return { valid: false, activatedForCaller: false };
  const pending = await getPendingAuditSnapshot(project.finalread_review_id);
  if (!pending) return { valid: false, activatedForCaller: false };
  return { valid: true, activatedForCaller: false, project, request: row, reportId: null };
}

export type ReserveResult = "reserved" | "in_use" | "invalid";

/**
 * Reserve a review request for checkout (30 minutes). Atomic: the
 * conditional UPDATE succeeds only when the request is uploaded (bound
 * to a project), or its reservation has expired, or it is already
 * reserved by this buyer. Only one buyer can hold an active
 * reservation. Returns "in_use" when another buyer holds an unexpired
 * reservation (the checkout tells them the code is already in use);
 * "invalid" when the request cannot be used at all.
 */
export async function reserveReviewRequestCode(
  requestId: string,
  buyerUserId: string
): Promise<ReserveResult> {
  const db = getDb();
  const row = await db.get<ReviewRequestRow>(
    "SELECT * FROM finalread_review_requests WHERE id = $1",
    [requestId]
  );
  if (!row) return "invalid";
  if (row.status === "activated" || row.status === "revoked") return "invalid";
  if (requestExpired(row)) return "invalid";
  if (requestReservationActive(row) && row.reserved_by !== buyerUserId) return "in_use";
  if (!row.project_id) return "invalid";
  if (await projectHasActivatedBuyer(row.project_id)) return "invalid";
  const now = new Date();
  const reservedUntil = new Date(
    now.getTime() + REVIEW_REQUEST_RESERVATION_MINUTES * 60 * 1000
  );
  const result = await db.run(
    "UPDATE finalread_review_requests SET status = $1, reserved_by = $2, reserved_until = $3, updated_at = $4 WHERE id = $5 AND (status = $6 OR (status = $7 AND (reserved_until <= $8 OR reserved_by = $9)))",
    [
      "reserved",
      buyerUserId,
      reservedUntil.toISOString(),
      now.toISOString(),
      requestId,
      "uploaded",
      "reserved",
      now.toISOString(),
      buyerUserId,
    ]
  );
  if (result.changes === 1) return "reserved";
  // Lost a race: re-read to tell "in use" apart from "invalid".
  const after = await db.get<ReviewRequestRow>(
    "SELECT * FROM finalread_review_requests WHERE id = $1",
    [requestId]
  );
  if (after && requestReservationActive(after) && after.reserved_by !== buyerUserId) {
    return "in_use";
  }
  return "invalid";
}

// Seller-issued invite-code revocation is SUPERSEDED by the two-sided
// flow: requests are revoked by project closure, by activation of
// another request for the same project, or by re-binding to a new code.
// There is no standalone revoke endpoint.

// ---- Buyer access (resource-level authorization) ----

export async function getBuyerAccess(
  buyerUserId: string,
  reviewId: string
): Promise<BuyerAccessRow | undefined> {
  return getDb().get<BuyerAccessRow>(
    "SELECT * FROM finalread_buyer_access WHERE buyer_user_id = $1 AND review_id = $2",
    [buyerUserId, reviewId]
  );
}

export async function hasBuyerAccess(
  buyerUserId: string,
  reviewId: string
): Promise<boolean> {
  return (await getBuyerAccess(buyerUserId, reviewId)) !== undefined;
}

// ---- Q&A history (per-version, server-side) ----

export async function appendQaTurn(opts: {
  versionId: string;
  reviewId: string;
  buyerUserId: string;
  question: string;
  answer: string;
  citedFindings: string[];
}): Promise<void> {
  await getDb().run(
    "INSERT INTO finalread_qa_history (version_id, review_id, buyer_user_id, question, answer, cited_findings, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [
      opts.versionId,
      opts.reviewId,
      opts.buyerUserId,
      opts.question,
      opts.answer,
      toJson(opts.citedFindings),
      new Date().toISOString(),
    ]
  );
}

export async function getQaHistoryForVersion(
  versionId: string
): Promise<Array<{ question: string; answer: string; citedFindings: string[] }>> {
  const rows = await getDb().all<QaHistoryRow>(
    "SELECT * FROM finalread_qa_history WHERE version_id = $1 ORDER BY created_at ASC",
    [versionId]
  );
  return rows.map((r) => ({
    question: r.question,
    answer: r.answer,
    citedFindings: parseJson<string[]>(r.cited_findings),
  }));
}

export async function getQaHistoryForReview(reviewId: string): Promise<QaHistoryRow[]> {
  return getDb().all<QaHistoryRow>(
    "SELECT * FROM finalread_qa_history WHERE review_id = $1 ORDER BY created_at ASC",
    [reviewId]
  );
}

// ---- Ask target: the stored report a Q&A question is answered from ----

export interface AskTarget {
  review: FinalReadReviewRow;
  version: ReviewVersionRow;
  report: FinalReadReportRow;
  /** The stored audit (the assessment the report was built from). */
  audit: unknown;
}

/**
 * Resolve a Q&A request to the stored report it asks about. The report id
 * is the primary handle; a review id resolves to that review's latest
 * report. Returns undefined when there is no report to ask about (not
 * paid yet, or no such report) — the caller answers 404, no enumeration.
 */
export async function resolveAskTarget(opts: {
  reportId?: string;
  reviewId?: string;
}): Promise<AskTarget | undefined> {
  const db = getDb();
  let report: FinalReadReportRow | undefined;
  if (opts.reportId) {
    report = await getReport(opts.reportId);
  } else if (opts.reviewId) {
    report = await getLatestReportForReview(opts.reviewId);
  }
  if (!report) return undefined;
  const version = await db.get<ReviewVersionRow>(
    "SELECT * FROM finalread_review_versions WHERE id = $1",
    [report.version_id]
  );
  const review = await db.get<FinalReadReviewRow>(
    "SELECT * FROM finalread_reviews WHERE id = $1",
    [report.review_id]
  );
  if (!version || !review) return undefined;
  const snapshot = version.audit_snapshot_id
    ? await getAuditSnapshot(version.audit_snapshot_id)
    : undefined;
  if (!snapshot) return undefined;
  return { review, version, report, audit: parseJson(snapshot.audit) };
}

// ---- Report generation from a stored audit ----

/**
 * Create a version + audit snapshot + report from an audit the server
 * already holds (a re-scan, or a report job). The version id is generated
 * up front so the snapshot can reference it without an update.
 */
export async function createVersionReport(
  db: Db,
  opts: {
    reviewId: string;
    projectId: string | null;
    versionNumber: number;
    contentHash: string;
    audit: unknown;
    stripeEventId: string | null;
  }
): Promise<{ version: ReviewVersionRow; report: FinalReadReportRow; snapshot: AuditSnapshotRow }> {
  const versionId = `frvv_${crypto.randomUUID()}`;
  const snapshotId = `fras_${crypto.randomUUID()}`;
  const reportId = `frr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO finalread_audit_snapshots (id, version_id, review_id, audit, content_hash, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [snapshotId, versionId, opts.reviewId, toJson(opts.audit), opts.contentHash, "active", now]
  );
  await db.run(
    "INSERT INTO finalread_review_versions (id, review_id, project_id, version_number, content_hash, audit_snapshot_id, stripe_event_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      versionId,
      opts.reviewId,
      opts.projectId,
      opts.versionNumber,
      opts.contentHash,
      snapshotId,
      opts.stripeEventId,
      now,
    ]
  );
  const report = stripLedgerSourceText(buildFinalReadReport(opts.audit as any));
  await db.run(
    "INSERT INTO finalread_reports (id, version_id, review_id, report, created_at) VALUES ($1, $2, $3, $4, $5)",
    [reportId, versionId, opts.reviewId, toJson(report), now]
  );
  const version = await db.get<ReviewVersionRow>(
    "SELECT * FROM finalread_review_versions WHERE id = $1",
    [versionId]
  );
  const reportRow = await db.get<FinalReadReportRow>(
    "SELECT * FROM finalread_reports WHERE id = $1",
    [reportId]
  );
  const snapshot = await db.get<AuditSnapshotRow>(
    "SELECT * FROM finalread_audit_snapshots WHERE id = $1",
    [snapshotId]
  );
  if (!version || !reportRow || !snapshot) throw new Error("Failed to create version report");
  return { version, report: reportRow, snapshot };
}

/**
 * Generate version 1's report from the pending audit at payment time
 * (spec §5.2). Reads the stored pending audit — never the seller's
 * browser — verifies its hash against the seller's saved code (defensive
 * re-check; a mismatch is logged, not fatal: the audit is the pinned
 * assessment of the code it scanned), creates the version row with the
 * pending audit's hash, marks the snapshot active, creates the report row,
 * and records the purchase on the review and the project.
 *
 * Returns null when there is no pending audit (the missing-audit edge
 * case): the caller grants the payment and enqueues a server-side scan
 * instead of failing the payment.
 */
export async function generateReportFromPendingAudit(
  db: Db,
  opts: { reviewId: string; stripeEventId: string | null }
): Promise<{ version: ReviewVersionRow; report: FinalReadReportRow } | null> {
  const review = await db.get<FinalReadReviewRow>(
    "SELECT * FROM finalread_reviews WHERE id = $1",
    [opts.reviewId]
  );
  if (!review) return null;
  const snapshot = await db.get<AuditSnapshotRow>(
    "SELECT * FROM finalread_audit_snapshots WHERE review_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1",
    [opts.reviewId, "pending"]
  );
  if (!snapshot) return null;
  // Defensive re-check: the pending audit's hash should still match the
  // seller's saved code (it has not changed since the scan — a re-scan
  // creates a new version). A mismatch means the workspace drifted outside
  // the project flow; the audit is still the pinned assessment, so the
  // report is generated from it and the drift is logged.
  try {
    const files = await listWorkspaceFiles(review.seller_user_id);
    if (files.length > 0) {
      const currentHash = hashReviewContent(
        files.map((f) => ({ path: f.path, content: f.content }))
      );
      if (currentHash !== snapshot.content_hash) {
        log.warn(
          `FinalRead report generation: pending audit hash mismatch for review ${opts.reviewId} (workspace drifted since the scan)`
        );
      }
    }
  } catch (err: any) {
    log.warn(
      `FinalRead report generation: could not verify pending audit hash for review ${opts.reviewId}: ${err?.message || err}`
    );
  }
  const versionId = `frvv_${crypto.randomUUID()}`;
  const reportId = `frr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  // The one linking update the snapshot ever gets: its version link is set
  // and it becomes active. The audit JSON and content hash never change.
  await db.run(
    "UPDATE finalread_audit_snapshots SET version_id = $1, status = $2 WHERE id = $3",
    [versionId, "active", snapshot.id]
  );
  await db.run(
    "INSERT INTO finalread_review_versions (id, review_id, project_id, version_number, content_hash, audit_snapshot_id, stripe_event_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      versionId,
      opts.reviewId,
      review.project_id,
      1,
      snapshot.content_hash,
      snapshot.id,
      opts.stripeEventId,
      now,
    ]
  );
  const report = stripLedgerSourceText(buildFinalReadReport(parseJson(snapshot.audit) as any));
  await db.run(
    "INSERT INTO finalread_reports (id, version_id, review_id, report, created_at) VALUES ($1, $2, $3, $4, $5)",
    [reportId, versionId, opts.reviewId, toJson(report), now]
  );
  await db.run(
    "UPDATE finalread_reviews SET purchase_stripe_event_id = $1, updated_at = $2 WHERE id = $3",
    [opts.stripeEventId, now, opts.reviewId]
  );
  if (review.project_id && opts.stripeEventId) {
    await setProjectActive(db, review.project_id, opts.stripeEventId);
  }
  const version = await db.get<ReviewVersionRow>(
    "SELECT * FROM finalread_review_versions WHERE id = $1",
    [versionId]
  );
  const reportRow = await db.get<FinalReadReportRow>(
    "SELECT * FROM finalread_reports WHERE id = $1",
    [reportId]
  );
  if (!version || !reportRow) throw new Error("Failed to generate report from pending audit");
  return { version, report: reportRow };
}

/**
 * Lazy entry-report generation (stakeholder-view gate spec §5): the
 * payment-time trigger for an entry-flow review. The billing webhook
 * cannot know the review — an entry purchase carries no invite code and
 * no project — so the first PAID fetch of the review's report generates
 * it from the stored pending audit (deterministic, no model call).
 *
 * Entry flow only (project_id NULL) and seller only: a project review's
 * report is generated by the invite-code webhook, never by a fetch, and
 * a stranger cannot claim a purchase onto someone else's review. The
 * purchase is the review's recorded event when the caller already held
 * it at scan time, otherwise the caller's latest $199 purchase (claimed
 * here — generateReportFromPendingAudit records it on the review). When
 * the caller has not paid, or no pending audit exists (a review created
 * before the gate build), this returns undefined and the caller sees the
 * 403/404 the route already answers — the report is never generated
 * without a payment, and never from a client-supplied audit.
 */
export async function generateReportForPaidEntryReview(
  reviewId: string,
  userId: string
): Promise<FinalReadReportRow | undefined> {
  const db = getDb();
  const review = await db.get<FinalReadReviewRow>(
    "SELECT * FROM finalread_reviews WHERE id = $1",
    [reviewId]
  );
  if (!review || review.project_id) return undefined;
  if (review.seller_user_id !== userId) return undefined;
  const existing = await getLatestReportForReview(reviewId);
  if (existing) return existing;
  const purchaseEventId =
    review.purchase_stripe_event_id ?? (await findLatestFinalReadPurchase(userId));
  if (!purchaseEventId) return undefined;
  const generated = await generateReportFromPendingAudit(db, {
    reviewId,
    stripeEventId: purchaseEventId,
  });
  return generated?.report;
}

// ---- Activation (atomic) ----

export interface ActivationResult {
  ok: boolean;
  reason?: string;
  buyerAccessId?: string;
  reportId?: string | null;
}

/**
 * Idempotency guard (two-sided flow §4e): a Stripe event id that
 * already produced a buyer-access row for this buyer counts as an
 * already-successful activation. A retried webhook (or a retried claim)
 * must not re-activate — and must not refund — a payment that already
 * succeeded. Checked BEFORE the reserve in both the webhook and claim
 * paths, because a re-reserve of an already-activated request would
 * fail and look like a losing payment.
 */
export async function findBuyerAccessByStripeEvent(
  stripeEventId: string,
  buyerUserId: string
): Promise<BuyerAccessRow | undefined> {
  return getDb().get<BuyerAccessRow>(
    "SELECT * FROM finalread_buyer_access WHERE stripe_event_id = $1 AND buyer_user_id = $2",
    [stripeEventId, buyerUserId]
  );
}

/**
 * Activate a review request for the buyer who paid, atomically:
 * 1. A single conditional UPDATE flips the request reserved ->
 *    activated. It must affect exactly 1 row; 0 rows means the
 *    activation failed (the request was already activated by another
 *    buyer, the reservation expired, or it belongs to another buyer).
 * 2. In one transaction: the buyer-access record is created, every
 *    other unactivated request for the project is revoked (one buyer
 *    per project), and the report is generated from the pending audit.
 *
 * The caller grants the credits + entitlements ONLY on activation
 * success (spec §4e — activate FIRST, grant SECOND). On failure the
 * caller refunds the $199 and grants NOTHING — a losing payment is
 * never silently ignored and never gives the product away.
 */
export async function activateReviewRequestForUser(opts: {
  requestCodeId: string;
  projectId: string;
  buyerUserId: string;
  stripeEventId: string;
}): Promise<ActivationResult> {
  const db = getDb();
  const project = await getFinalReadProject(opts.projectId);
  if (!project || !project.finalread_review_id) {
    return { ok: false, reason: "invalid" };
  }
  const reviewId = project.finalread_review_id;
  const now = new Date();
  const activated = await db.run(
    "UPDATE finalread_review_requests SET status = $1, used_at = $2, updated_at = $3 WHERE id = $4 AND status = $5 AND reserved_by = $6 AND reserved_until > $7",
    [
      "activated",
      now.toISOString(),
      now.toISOString(),
      opts.requestCodeId,
      "reserved",
      opts.buyerUserId,
      now.toISOString(),
    ]
  );
  if (activated.changes !== 1) {
    return { ok: false, reason: "activation_failed" };
  }
  const outcome = await db.transaction(async (tx) => {
    const accessId = `frba_${crypto.randomUUID()}`;
    await tx.run(
      "INSERT INTO finalread_buyer_access (id, buyer_user_id, project_id, review_id, invite_code_id, stripe_event_id, activated_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        accessId,
        opts.buyerUserId,
        opts.projectId,
        reviewId,
        opts.requestCodeId,
        opts.stripeEventId,
        now.toISOString(),
        now.toISOString(),
      ]
    );
    await tx.run(
      "UPDATE finalread_review_requests SET status = $1, updated_at = $2 WHERE project_id = $3 AND id != $4 AND status IN ($5, $6)",
      ["revoked", now.toISOString(), opts.projectId, opts.requestCodeId, "uploaded", "reserved"]
    );
    const generated = await generateReportFromPendingAudit(tx, {
      reviewId,
      stripeEventId: opts.stripeEventId,
    });
    return { accessId, reportId: generated ? generated.report.id : null };
  });
  if (outcome.reportId === null) {
    // Missing-audit edge case (spec §5.2): the payment is recorded, the
    // credits + entitlements are granted, and the request IS activated —
    // the report is generated by an enqueued server-side scan instead of
    // failing the payment. The buyer sees "report is being generated"
    // until the job completes. Enqueue only: the scan runs when the
    // report is fetched (never a model call inside the webhook).
    await createReportJob(reviewId, opts.stripeEventId);
  }
  return { ok: true, buyerAccessId: outcome.accessId, reportId: outcome.reportId };
}

// ---- Parked purchases: the review-request activation follows the claim ----

export async function createPendingActivation(opts: {
  stripeEventId: string;
  /** Review-request id (stored in the legacy invite_code_id column). */
  requestCodeId: string;
  projectId: string;
  email: string;
  /** Stored so a failed activation at claim time can still refund. */
  paymentIntent?: string | null;
}): Promise<void> {
  const db = getDb();
  const sql =
    db.dialect === "postgres"
      ? "INSERT INTO finalread_pending_activations (stripe_event_id, invite_code_id, project_id, email, payment_intent, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (stripe_event_id) DO NOTHING"
      : "INSERT OR IGNORE INTO finalread_pending_activations (stripe_event_id, invite_code_id, project_id, email, payment_intent, created_at) VALUES ($1, $2, $3, $4, $5, $6)";
  await db.run(sql, [
    opts.stripeEventId,
    opts.requestCodeId,
    opts.projectId,
    opts.email,
    opts.paymentIntent ?? null,
    new Date().toISOString(),
  ]);
}

export async function getPendingActivation(
  stripeEventId: string
): Promise<PendingActivationRow | undefined> {
  return getDb().get<PendingActivationRow>(
    "SELECT * FROM finalread_pending_activations WHERE stripe_event_id = $1",
    [stripeEventId]
  );
}

export async function deletePendingActivation(stripeEventId: string): Promise<void> {
  await getDb().run("DELETE FROM finalread_pending_activations WHERE stripe_event_id = $1", [
    stripeEventId,
  ]);
}

/**
 * Attempt ONE parked activation (two-sided flow §4g): the claim-path
 * reorder — activation is attempted BEFORE the credits + entitlements
 * are claimed (claimPendingCredits calls this first; only on success
 * does it claim the pack). On activation failure the $199 is refunded,
 * the parked row is deleted, and NOTHING is claimed. The idempotency
 * guard runs first: a prior success for this Stripe event id + buyer
 * counts as success, so a retried claim never refunds a payment that
 * already activated. The checkout reservation (30 min) may have
 * expired while the purchase was parked, so the request is re-reserved
 * for the buyer who already paid before activating — a slow claim is
 * not punished with a refund. Processed rows are deleted either way; a
 * failed activation's refund record is the durable trace.
 */
export async function attemptPendingActivation(
  row: PendingActivationRow,
  userId: string,
  email: string
): Promise<void> {
  const already = await findBuyerAccessByStripeEvent(row.stripe_event_id, userId);
  if (already) {
    // Idempotent: this payment already activated — nothing left to do,
    // but the parked row is done and must not linger for a later claim.
    await deletePendingActivation(row.stripe_event_id);
    return;
  }
  try {
    const reserved = await reserveReviewRequestCode(row.invite_code_id, userId);
    if (reserved !== "reserved") {
      await refundLosingFinalReadPayment({
        eventId: row.stripe_event_id,
        requestCodeId: row.invite_code_id,
        projectId: row.project_id,
        buyerUserId: userId,
        buyerEmail: email,
        paymentIntent: row.payment_intent,
        reason: reserved === "in_use" ? "code_in_use" : "invalid",
      });
    } else {
      const activated = await activateReviewRequestForUser({
        requestCodeId: row.invite_code_id,
        projectId: row.project_id,
        buyerUserId: userId,
        stripeEventId: row.stripe_event_id,
      });
      if (!activated.ok) {
        await refundLosingFinalReadPayment({
          eventId: row.stripe_event_id,
          requestCodeId: row.invite_code_id,
          projectId: row.project_id,
          buyerUserId: userId,
          buyerEmail: email,
          paymentIntent: row.payment_intent,
          reason: activated.reason ?? "activation_failed",
        });
      }
    }
  } catch (err: any) {
    log.error(
      `Failed to process pending FinalRead activation ${row.stripe_event_id}: ${err?.message || err}`
    );
  } finally {
    await deletePendingActivation(row.stripe_event_id);
  }
}

/**
 * Claim every pending activation parked against the buyer's email.
 * Called from claimPendingCredits BEFORE the credits + entitlements are
 * claimed (two-sided flow §4g): a parked FinalRead purchase attempts
 * its activation first, and only an activation that succeeds (or was
 * already successful for this event) lets the pack be claimed.
 */
export async function processPendingActivationsForUser(
  userId: string,
  email: string
): Promise<void> {
  const rows = await getDb().all<PendingActivationRow>(
    "SELECT * FROM finalread_pending_activations WHERE email = $1",
    [email]
  );
  for (const row of rows) {
    await attemptPendingActivation(row, userId, email);
  }
}

/**
 * The losing-payment refund (spec §9.7): synchronous Stripe refund +
 * a durable refund record, so a failed refund is never silently lost.
 * The buyer is told by email. Used by the webhook and by the claim path
 * (a parked purchase whose activation fails at claim time refunds the
 * same way).
 */
export async function refundLosingFinalReadPayment(opts: {
  eventId: string;
  /** Review-request id (stored in the legacy invite_code_id column). */
  requestCodeId: string;
  projectId: string;
  buyerUserId: string;
  buyerEmail: string;
  paymentIntent: string | null;
  reason: string;
}): Promise<void> {
  const { eventId, requestCodeId, projectId, buyerUserId, buyerEmail, paymentIntent, reason } =
    opts;
  if (!paymentIntent) {
    // No payment intent to refund against — record it so the payment is
    // reconciled by hand rather than silently kept.
    await recordRefund({
      stripeEventId: eventId,
      inviteCodeId: requestCodeId,
      projectId,
      buyerUserId,
      paymentIntent: null,
      refundId: null,
      status: "failed",
      error: "No payment intent on the session; manual reconciliation required",
    });
    log.error(
      `FinalRead losing payment ${eventId} has no payment intent to refund (code ${requestCodeId}); recorded for manual reconciliation`
    );
    return;
  }
  try {
    const refund = await createStripeRefund(paymentIntent);
    await recordRefund({
      stripeEventId: eventId,
      inviteCodeId: requestCodeId,
      projectId,
      buyerUserId,
      paymentIntent,
      refundId: typeof refund?.id === "string" ? refund.id : null,
      status: "refunded",
      error: null,
    });
    log.info(
      `FinalRead losing payment refunded: ${paymentIntent} (event ${eventId}, code ${requestCodeId}, reason: ${reason})`
    );
    if (buyerEmail) {
      await sendFinalReadRefundEmail(buyerEmail, {
        amount: "$199",
        reason,
        inviteCodeId: requestCodeId,
      });
    }
  } catch (err: any) {
    await recordRefund({
      stripeEventId: eventId,
      inviteCodeId: requestCodeId,
      projectId,
      buyerUserId,
      paymentIntent,
      refundId: null,
      status: "failed",
      error: err?.message || String(err),
    });
    log.error(
      `FinalRead losing-payment refund FAILED for ${paymentIntent} (event ${eventId}, code ${requestCodeId}): ${err?.message || err} — recorded for manual reconciliation`
    );
  }
}

// ---- Losing-payment refund records (never silently ignored) ----

export async function recordRefund(opts: {
  stripeEventId: string;
  inviteCodeId: string | null;
  projectId: string | null;
  buyerUserId: string;
  paymentIntent: string | null;
  refundId: string | null;
  status: "refunded" | "failed";
  error?: string | null;
}): Promise<void> {
  await getDb().run(
    "INSERT INTO finalread_refund_records (stripe_event_id, invite_code_id, project_id, buyer_user_id, payment_intent, refund_id, status, error, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      opts.stripeEventId,
      opts.inviteCodeId,
      opts.projectId,
      opts.buyerUserId,
      opts.paymentIntent,
      opts.refundId,
      opts.status,
      opts.error ?? null,
      new Date().toISOString(),
    ]
  );
}

export async function getRefundRecord(
  stripeEventId: string
): Promise<RefundRecordRow | undefined> {
  return getDb().get<RefundRecordRow>(
    "SELECT * FROM finalread_refund_records WHERE stripe_event_id = $1",
    [stripeEventId]
  );
}

// ---- Missing-audit report jobs (the follow-up scan) ----

export async function createReportJob(
  reviewId: string,
  stripeEventId: string | null
): Promise<ReportJobRow> {
  const db = getDb();
  const existing = await db.get<ReportJobRow>(
    "SELECT * FROM finalread_report_jobs WHERE review_id = $1 AND status IN ($2, $3) ORDER BY created_at DESC LIMIT 1",
    [reviewId, "pending", "failed"]
  );
  if (existing) return existing;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO finalread_report_jobs (review_id, stripe_event_id, status, error, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [reviewId, stripeEventId, "pending", null, now, now]
  );
  const row = await db.get<ReportJobRow>(
    "SELECT * FROM finalread_report_jobs WHERE review_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1",
    [reviewId, "pending"]
  );
  if (!row) throw new Error("Failed to create report job");
  return row;
}

export async function getReportJobForReview(
  reviewId: string
): Promise<ReportJobRow | undefined> {
  return getDb().get<ReportJobRow>(
    "SELECT * FROM finalread_report_jobs WHERE review_id = $1 ORDER BY created_at DESC LIMIT 1",
    [reviewId]
  );
}

/**
 * Run every pending (or failed — retry on next fetch) report job: re-run
 * the intelligence scan over the seller's saved project files and create
 * the version + report the payment was supposed to generate. No charge:
 * the buyer already paid. A failed scan leaves the job failed with the
 * error recorded, so the next report fetch retries it instead of losing
 * the buyer's report silently.
 */
export async function processPendingReportJobs(): Promise<void> {
  const db = getDb();
  const jobs = await db.all<ReportJobRow>(
    "SELECT * FROM finalread_report_jobs WHERE status IN ($1, $2) ORDER BY created_at ASC",
    ["pending", "failed"]
  );
  for (const job of jobs) {
    try {
      const review = await db.get<FinalReadReviewRow>(
        "SELECT * FROM finalread_reviews WHERE id = $1",
        [job.review_id]
      );
      if (!review) throw new Error("Review not found");
      const files = await listWorkspaceFiles(review.seller_user_id);
      if (files.length === 0) throw new Error("Seller workspace is empty");
      const { runIntelligenceScan } = await import("./intelligence-scan");
      // runIntelligenceScan returns { audit, usage, modelName }: the
      // version stores the AUDIT, not the wrapper — storing the wrapper
      // would leave the report with no completenessScore (0).
      const { audit } = await runIntelligenceScan(
        files.map((f) => ({ path: f.path, content: f.content, lineCount: f.lineCount })),
        { userId: review.seller_user_id, fromWorkspace: true }
      );
      const contentHash = hashReviewContent(
        files.map((f) => ({ path: f.path, content: f.content }))
      );
      const latest = await getLatestReviewVersion(job.review_id);
      const versionNumber = latest ? latest.version_number + 1 : 1;
      await db.transaction(async (tx) => {
        await createVersionReport(tx, {
          reviewId: job.review_id,
          projectId: review.project_id,
          versionNumber,
          contentHash,
          audit,
          stripeEventId: job.stripe_event_id,
        });
        await tx.run(
          "UPDATE finalread_report_jobs SET status = $1, error = $2, updated_at = $3 WHERE id = $4",
          ["done", null, new Date().toISOString(), job.id]
        );
      });
      log.info(`FinalRead report job ${job.id} completed for review ${job.review_id}`);
    } catch (err: any) {
      const message = err?.message || String(err);
      await db
        .run(
          "UPDATE finalread_report_jobs SET status = $1, error = $2, updated_at = $3 WHERE id = $4",
          ["failed", message.slice(0, 500), new Date().toISOString(), job.id]
        )
        .catch(() => undefined);
      log.error(`FinalRead report job ${job.id} failed for review ${job.review_id}: ${message}`);
    }
  }
}
