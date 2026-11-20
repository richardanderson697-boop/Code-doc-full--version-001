// FinalRead seller project saving: the versioned transaction model.
//
// Implements finalread-seller-project-saving-spec.md (Revision 2,
// APPROVED 2026-11-20). The store-level helpers for the eight versioned
// tables plus the invite-code lifecycle, the pending-audit report
// generation, the atomic activation, the losing-payment refund record,
// and the missing-audit report job.
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
import crypto from "crypto";
import { getDb, type Db } from "./store";
import { log } from "./logger";
import {
  createReviewVersionRow,
  getLatestReviewVersion,
  hashReviewContent,
  type FinalReadReviewRow,
  type ReviewVersionRow,
} from "./finalread-rescans";
import { buildFinalReadReport } from "../shared/finalread-report";
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
  status: "draft" | "active" | "closed";
  created_at: string;
  updated_at: string;
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

// ---- Projects (seller-owned, owner-scoped, 404 cross-user) ----

export async function createFinalReadProject(
  sellerUserId: string,
  title: string
): Promise<FinalReadProjectRow> {
  const db = getDb();
  const id = `frp_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO finalread_projects (id, seller_user_id, title, finalread_review_id, purchase_stripe_event_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [id, sellerUserId, title, null, null, "draft", now, now]
  );
  const row = await db.get<FinalReadProjectRow>(
    "SELECT * FROM finalread_projects WHERE id = $1",
    [id]
  );
  if (!row) throw new Error("Failed to create FinalRead project");
  return row;
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

/**
 * Close (soft-delete) a project: status -> closed, hidden from the seller's
 * active list. The project row and every paid record survive closure (the
 * buyer keeps the report, the Q&A history, and the audit snapshots). Only
 * unactivated invite codes are revoked — they were never paid for. Returns
 * false when the project does not exist or belongs to someone else.
 */
export async function closeFinalReadProject(
  id: string,
  sellerUserId: string
): Promise<boolean> {
  const db = getDb();
  const project = await getFinalReadProjectForSeller(id, sellerUserId);
  if (!project) return false;
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE finalread_projects SET status = $1, updated_at = $2 WHERE id = $3",
      ["closed", new Date().toISOString(), id]
    );
    await tx.run(
      "UPDATE finalread_invite_codes SET status = $1, updated_at = $2 WHERE project_id = $3 AND status IN ($4, $5)",
      ["revoked", new Date().toISOString(), id, "issued", "reserved"]
    );
  });
  return true;
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

// ---- Invite codes (hash-only storage, 30-day expiry, one buyer per project) ----

/** Checkout reservation length: the Stripe session expires with it. */
export const INVITE_RESERVATION_MINUTES = 30;
/** Invite-code expiry when never activated. */
export const INVITE_EXPIRY_DAYS = 30;

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

function inviteCodeExpired(row: InviteCodeRow, now: Date = new Date()): boolean {
  return new Date(row.expires_at).getTime() <= now.getTime();
}

function reservationActive(row: InviteCodeRow, now: Date = new Date()): boolean {
  return (
    row.status === "reserved" &&
    !!row.reserved_until &&
    new Date(row.reserved_until).getTime() > now.getTime()
  );
}

/**
 * Issue an invite code for a project. The seller cannot issue a code until
 * a pending audit exists (the initial scan has run) — a code for a project
 * with no audit would let a buyer pay for a report that cannot be
 * generated. Returns the plaintext code ONCE (the seller copies it); only
 * the hash is stored.
 */
export async function createInviteCode(
  projectId: string
): Promise<{ code: string; row: InviteCodeRow }> {
  const db = getDb();
  const project = await getFinalReadProject(projectId);
  if (!project) throw new Error("Project not found");
  if (project.status === "closed") throw new Error("Project is closed");
  if (await projectHasActivatedBuyer(projectId)) {
    throw new Error("Project already has a buyer");
  }
  if (!project.finalread_review_id) throw new Error("Project has no review yet");
  const pending = await getPendingAuditSnapshot(project.finalread_review_id);
  if (!pending) throw new Error("Run the initial scan before inviting a buyer");
  const code = generateInviteCode();
  const id = `fric_${crypto.randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  await db.run(
    "INSERT INTO finalread_invite_codes (id, project_id, code_hash, status, reserved_by, reserved_until, used_at, buyer_user_id, expires_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    [
      id,
      projectId,
      hashInviteCode(code),
      "issued",
      null,
      null,
      null,
      null,
      expiresAt.toISOString(),
      now.toISOString(),
      now.toISOString(),
    ]
  );
  const row = await db.get<InviteCodeRow>(
    "SELECT * FROM finalread_invite_codes WHERE id = $1",
    [id]
  );
  if (!row) throw new Error("Failed to create invite code");
  return { code, row };
}

export async function findInviteCodeByHash(
  codeHash: string
): Promise<InviteCodeRow | undefined> {
  return getDb().get<InviteCodeRow>(
    "SELECT * FROM finalread_invite_codes WHERE code_hash = $1",
    [codeHash]
  );
}

export async function getInviteCodesForProject(
  projectId: string
): Promise<InviteCodeRow[]> {
  return getDb().all<InviteCodeRow>(
    "SELECT * FROM finalread_invite_codes WHERE project_id = $1 ORDER BY created_at DESC",
    [projectId]
  );
}

export async function projectHasActivatedBuyer(projectId: string): Promise<boolean> {
  const row = await getDb().get<{ id: string }>(
    "SELECT id FROM finalread_buyer_access WHERE project_id = $1 LIMIT 1",
    [projectId]
  );
  return !!row;
}

export interface InviteCodeValidation {
  valid: boolean;
  /** The code is already activated for this caller — they view the report, they do not pay again. */
  activatedForCaller: boolean;
  project?: FinalReadProjectRow;
  code?: InviteCodeRow;
  reportId?: string | null;
}

/**
 * Validate a buyer-entered code. Every failure returns the same generic
 * shape (valid: false) — no enumeration of whether a code exists, is
 * expired, or is already used. A code reserved by ANOTHER buyer whose
 * reservation is still active is not valid here; the "already in use"
 * message is given at checkout time instead (criterion 15).
 */
export async function validateInviteCode(
  code: string,
  callerUserId: string
): Promise<InviteCodeValidation> {
  const row = await findInviteCodeByHash(hashInviteCode(code));
  if (!row) return { valid: false, activatedForCaller: false };
  if (row.status === "revoked") return { valid: false, activatedForCaller: false };
  if (inviteCodeExpired(row)) return { valid: false, activatedForCaller: false };
  if (row.status === "activated") {
    if (row.buyer_user_id !== callerUserId) {
      return { valid: false, activatedForCaller: false };
    }
    const project = await getFinalReadProject(row.project_id);
    if (!project || !project.finalread_review_id) {
      return { valid: false, activatedForCaller: false };
    }
    const report = await getLatestReportForReview(project.finalread_review_id);
    return {
      valid: true,
      activatedForCaller: true,
      project,
      code: row,
      reportId: report ? report.id : null,
    };
  }
  if (reservationActive(row) && row.reserved_by !== callerUserId) {
    return { valid: false, activatedForCaller: false };
  }
  const project = await getFinalReadProject(row.project_id);
  if (!project) return { valid: false, activatedForCaller: false };
  if (await projectHasActivatedBuyer(row.project_id)) {
    return { valid: false, activatedForCaller: false };
  }
  return { valid: true, activatedForCaller: false, project, code: row, reportId: null };
}

export type ReserveResult = "reserved" | "in_use" | "invalid";

/**
 * Reserve an invite code for checkout (30 minutes). Atomic: the conditional
 * UPDATE succeeds only when the code is issued, or its reservation has
 * expired, or it is already reserved by this buyer. Only one buyer can
 * hold an active reservation. Returns "in_use" when another buyer holds an
 * unexpired reservation (the checkout tells them the code is already in
 * use); "invalid" when the code cannot be used at all.
 */
export async function reserveInviteCode(
  codeId: string,
  buyerUserId: string
): Promise<ReserveResult> {
  const db = getDb();
  const row = await db.get<InviteCodeRow>(
    "SELECT * FROM finalread_invite_codes WHERE id = $1",
    [codeId]
  );
  if (!row) return "invalid";
  if (row.status === "activated" || row.status === "revoked") return "invalid";
  if (inviteCodeExpired(row)) return "invalid";
  if (reservationActive(row) && row.reserved_by !== buyerUserId) return "in_use";
  if (await projectHasActivatedBuyer(row.project_id)) return "invalid";
  const now = new Date();
  const reservedUntil = new Date(now.getTime() + INVITE_RESERVATION_MINUTES * 60 * 1000);
  const result = await db.run(
    "UPDATE finalread_invite_codes SET status = $1, reserved_by = $2, reserved_until = $3, updated_at = $4 WHERE id = $5 AND (status = $6 OR (status = $7 AND (reserved_until <= $8 OR reserved_by = $9)))",
    [
      "reserved",
      buyerUserId,
      reservedUntil.toISOString(),
      now.toISOString(),
      codeId,
      "issued",
      "reserved",
      now.toISOString(),
      buyerUserId,
    ]
  );
  if (result.changes === 1) return "reserved";
  // Lost a race: re-read to tell "in use" apart from "invalid".
  const after = await db.get<InviteCodeRow>(
    "SELECT * FROM finalread_invite_codes WHERE id = $1",
    [codeId]
  );
  if (after && reservationActive(after) && after.reserved_by !== buyerUserId) return "in_use";
  return "invalid";
}

/**
 * Revoke an unactivated code (seller only). An activated code cannot be
 * revoked — the buyer paid for it. Returns false when the code does not
 * exist, belongs to another seller's project, or is already activated.
 */
export async function revokeInviteCode(
  codeId: string,
  sellerUserId: string
): Promise<boolean> {
  const db = getDb();
  const row = await db.get<InviteCodeRow>(
    "SELECT * FROM finalread_invite_codes WHERE id = $1",
    [codeId]
  );
  if (!row || row.status === "activated") return false;
  const project = await getFinalReadProjectForSeller(row.project_id, sellerUserId);
  if (!project) return false;
  const result = await db.run(
    "UPDATE finalread_invite_codes SET status = $1, updated_at = $2 WHERE id = $3 AND status IN ($4, $5)",
    ["revoked", new Date().toISOString(), codeId, "issued", "reserved"]
  );
  return result.changes === 1;
}

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
  const report = buildFinalReadReport(opts.audit as any);
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
  const report = buildFinalReadReport(parseJson(snapshot.audit) as any);
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

// ---- Activation (atomic) ----

export interface ActivationResult {
  ok: boolean;
  reason?: string;
  buyerAccessId?: string;
  reportId?: string | null;
}

/**
 * Activate an invite code for the buyer who paid, atomically:
 * 1. A single conditional UPDATE flips the code reserved -> activated. It
 *    must affect exactly 1 row; 0 rows means the activation failed (the
 *    code was already activated by another buyer, the reservation expired,
 *    or it belongs to another buyer).
 * 2. In one transaction: the buyer-access record is created, every other
 *    unactivated code for the project is revoked (one buyer per project),
 *    and the report is generated from the pending audit.
 *
 * On failure the caller grants the credits + entitlements anyway (the
 * buyer paid for the pack) and refunds the $199 — a losing payment is
 * never silently ignored.
 */
export async function activateInviteCodeForUser(opts: {
  inviteCodeId: string;
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
    "UPDATE finalread_invite_codes SET status = $1, used_at = $2, buyer_user_id = $3, updated_at = $4 WHERE id = $5 AND status = $6 AND reserved_by = $7 AND reserved_until > $8",
    [
      "activated",
      now.toISOString(),
      opts.buyerUserId,
      now.toISOString(),
      opts.inviteCodeId,
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
        opts.inviteCodeId,
        opts.stripeEventId,
        now.toISOString(),
        now.toISOString(),
      ]
    );
    await tx.run(
      "UPDATE finalread_invite_codes SET status = $1, updated_at = $2 WHERE project_id = $3 AND id != $4 AND status IN ($5, $6)",
      ["revoked", now.toISOString(), opts.projectId, opts.inviteCodeId, "issued", "reserved"]
    );
    const generated = await generateReportFromPendingAudit(tx, {
      reviewId,
      stripeEventId: opts.stripeEventId,
    });
    return { accessId, reportId: generated ? generated.report.id : null };
  });
  if (outcome.reportId === null) {
    // Missing-audit edge case (spec §5.2): the payment is recorded, the
    // credits + entitlements are granted, and the code IS activated — the
    // report is generated by an enqueued server-side scan instead of
    // failing the payment. The buyer sees "report is being generated"
    // until the job completes. Enqueue only: the scan runs when the
    // report is fetched (never a model call inside the webhook).
    await createReportJob(reviewId, opts.stripeEventId);
  }
  return { ok: true, buyerAccessId: outcome.accessId, reportId: outcome.reportId };
}

// ---- Parked purchases: the invite-code activation follows the claim ----

export async function createPendingActivation(opts: {
  stripeEventId: string;
  inviteCodeId: string;
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
    opts.inviteCodeId,
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
 * Claim every pending activation parked against the buyer's email (called
 * from claimPendingCredits, after the credits + entitlements are claimed).
 * The checkout reservation (30 min) may have expired while the purchase
 * was parked, so the code is re-reserved for the buyer who already paid
 * before activating — a slow claim is not punished with a refund. A
 * failed activation refunds the $199 the same way as the webhook path.
 * Processed rows are deleted either way; a failed activation's refund
 * record is the durable trace.
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
    try {
      const reserved = await reserveInviteCode(row.invite_code_id, userId);
      if (reserved !== "reserved") {
        await refundLosingFinalReadPayment({
          eventId: row.stripe_event_id,
          inviteCodeId: row.invite_code_id,
          projectId: row.project_id,
          buyerUserId: userId,
          buyerEmail: email,
          paymentIntent: row.payment_intent,
          reason: reserved === "in_use" ? "code_in_use" : "invalid",
        });
      } else {
        const activated = await activateInviteCodeForUser({
          inviteCodeId: row.invite_code_id,
          projectId: row.project_id,
          buyerUserId: userId,
          stripeEventId: row.stripe_event_id,
        });
        if (!activated.ok) {
          await refundLosingFinalReadPayment({
            eventId: row.stripe_event_id,
            inviteCodeId: row.invite_code_id,
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
  inviteCodeId: string;
  projectId: string;
  buyerUserId: string;
  buyerEmail: string;
  paymentIntent: string | null;
  reason: string;
}): Promise<void> {
  const { eventId, inviteCodeId, projectId, buyerUserId, buyerEmail, paymentIntent, reason } = opts;
  if (!paymentIntent) {
    // No payment intent to refund against — record it so the payment is
    // reconciled by hand rather than silently kept.
    await recordRefund({
      stripeEventId: eventId,
      inviteCodeId,
      projectId,
      buyerUserId,
      paymentIntent: null,
      refundId: null,
      status: "failed",
      error: "No payment intent on the session; manual reconciliation required",
    });
    log.error(
      `FinalRead losing payment ${eventId} has no payment intent to refund (code ${inviteCodeId}); recorded for manual reconciliation`
    );
    return;
  }
  try {
    const refund = await createStripeRefund(paymentIntent);
    await recordRefund({
      stripeEventId: eventId,
      inviteCodeId,
      projectId,
      buyerUserId,
      paymentIntent,
      refundId: typeof refund?.id === "string" ? refund.id : null,
      status: "refunded",
      error: null,
    });
    log.info(
      `FinalRead losing payment refunded: ${paymentIntent} (event ${eventId}, code ${inviteCodeId}, reason: ${reason})`
    );
    if (buyerEmail) {
      await sendFinalReadRefundEmail(buyerEmail, {
        amount: "$199",
        reason,
        inviteCodeId,
      });
    }
  } catch (err: any) {
    await recordRefund({
      stripeEventId: eventId,
      inviteCodeId,
      projectId,
      buyerUserId,
      paymentIntent,
      refundId: null,
      status: "failed",
      error: err?.message || String(err),
    });
    log.error(
      `FinalRead losing-payment refund FAILED for ${paymentIntent} (event ${eventId}, code ${inviteCodeId}): ${err?.message || err} — recorded for manual reconciliation`
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
