// FinalRead seller project saving: the project workspace API (spec
// Revision 2, §7–§9). Seller-owned projects, invite codes, the paid
// report, and the Q&A log.
//
// Access rules (spec §8, resource-level authorization — one ordinary
// account session, no distinct buyer session type):
// - A project belongs to its seller: another user gets a 404, never a leak.
// - The full report + Q&A are paid-only. The buyer who paid (an activated
//   buyer-access record for the review) reads the report and asks Q&A.
// - The seller sees the developer view (their scan result) until payment;
//   once the buyer pays, seller and buyer have EQUAL access to the report
//   (§5.3 post-payment parity). The seller sees the full Q&A log (§5.6
//   option (a)) but cannot ask questions without paid access.
// - The buyer never receives source code, workspace files, or the project
//   record: buyer access is scoped to ONE report (and its Q&A) only.
import { Router } from "express";
import { asyncRoute } from "../async-route";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import { log } from "../logger";
import {
  closeFinalReadProject,
  createFinalReadProject,
  createInviteCode,
  getFinalReadProjectForSeller,
  getInviteCodesForProject,
  getLatestReportForReview,
  getQaHistoryForReview,
  getReport,
  getReportJobForReview,
  getReportsForReview,
  hasBuyerAccess,
  listFinalReadProjects,
  parseJson,
  processPendingReportJobs,
  revokeInviteCode,
  validateInviteCode,
} from "../finalread-projects";
import {
  getFinalReadReview,
  getReviewVersions,
} from "../finalread-rescans";

const router = Router();

function projectShape(project: any) {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    finalreadReviewId: project.finalread_review_id,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

function inviteCodeShape(row: any) {
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

/** The seller's project, or a 404 when it is not theirs. */
async function sellerProject(req: AuthedRequest, res: any) {
  const project = await getFinalReadProjectForSeller(req.params.id, req.user!.id);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return undefined;
  }
  return project;
}

// ---- Projects (seller-only) ----

// Save a project in the seller's workspace (spec §7.1, save-before-scan:
// the seller uploads code, saves the project, then runs the initial scan
// FROM the saved project).
router.post("/api/finalread/projects", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "A project title is required." });
  if (title.length > 200) return res.status(400).json({ error: "Title is too long." });
  const project = await createFinalReadProject(req.user!.id, title);
  res.status(201).json({ project: projectShape(project) });
}));

// The seller's projects. Closed projects are hidden from the active list
// unless explicitly asked for.
router.get("/api/finalread/projects", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const includeClosed = req.query.includeClosed === "true";
  const projects = await listFinalReadProjects(req.user!.id);
  const visible = includeClosed
    ? projects
    : projects.filter((p) => p.status !== "closed");
  res.json({ projects: visible.map(projectShape) });
}));

// One project, with its review + version summary. The report CONTENT is
// not included here — it is fetched separately, paid-only.
router.get("/api/finalread/projects/:id", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const project = await sellerProject(req, res);
  if (!project) return;
  let review: any = undefined;
  let versions: any[] = [];
  if (project.finalread_review_id) {
    const found = await getFinalReadReview(project.finalread_review_id);
    if (found) {
      review = {
        id: found.review.id,
        purchaseStripeEventId: found.review.purchase_stripe_event_id,
        hasReport: (await getLatestReportForReview(found.review.id)) !== undefined,
      };
      versions = (await getReviewVersions(found.review.id)).map((v) => ({
        id: v.id,
        versionNumber: v.version_number,
        contentHash: v.content_hash,
        createdAt: v.created_at,
      }));
    }
  }
  res.json({ project: projectShape(project), review, versions });
}));

// Close (soft-delete) a project (spec §7.2). The paid report, buyer
// access, Q&A history, audit snapshots, and version rows are retained
// independently and survive closure; only unactivated invite codes are
// revoked. A hard delete of the code is out of scope.
router.post("/api/finalread/projects/:id/close", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const closed = await closeFinalReadProject(req.params.id, req.user!.id);
  if (!closed) return res.status(404).json({ error: "Project not found." });
  res.json({ closed: true });
}));

// ---- Invite codes (seller issues, buyer enters) ----

// Issue an invite code for a project. Requires a pending audit (the
// initial scan must have run) — a code for a project with no audit would
// let a buyer pay for a report that cannot be generated. The plaintext
// code is returned ONCE (the seller copies it to the buyer); only the
// hash is stored.
router.post("/api/finalread/projects/:id/invite-codes", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const project = await sellerProject(req, res);
  if (!project) return;
  try {
    const { code, row } = await createInviteCode(project.id);
    res.status(201).json({ code, inviteCode: inviteCodeShape(row) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Could not issue an invite code." });
  }
}));

router.get("/api/finalread/projects/:id/invite-codes", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const project = await sellerProject(req, res);
  if (!project) return;
  const codes = await getInviteCodesForProject(project.id);
  res.json({ inviteCodes: codes.map(inviteCodeShape) });
}));

// Revoke an unactivated code (seller only). An activated code cannot be
// revoked — the buyer paid for it.
router.post("/api/finalread/projects/:id/invite-codes/:codeId/revoke", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const revoked = await revokeInviteCode(req.params.codeId, req.user!.id);
  if (!revoked) return res.status(404).json({ error: "Invite code not found." });
  res.json({ revoked: true });
}));

// A buyer enters a code (auth required: the buyer signs in first, then
// enters the code). Every failure returns the same generic shape — no
// enumeration of whether a code exists, is expired, or is already used.
router.post("/api/finalread/invite-codes/validate", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!code.trim()) return res.status(400).json({ error: "An invite code is required." });
  const result = await validateInviteCode(code, req.user!.id);
  if (!result.valid) {
    return res.json({ valid: false });
  }
  res.json({
    valid: true,
    activatedForCaller: result.activatedForCaller,
    projectTitle: result.project?.title ?? null,
    projectId: result.project?.id ?? null,
    reportId: result.reportId ?? null,
  });
}));

// ---- Reports (paid-only) ----

// Fetch a report. Authorized: the buyer who paid for it (an activated
// buyer-access record), or the seller once the buyer has paid
// (post-payment parity, §5.3). Before payment the seller gets a 403 —
// they see the developer view, not the full report. A missing report
// with a pending/failed job is still generating: the fetch retries the
// job and answers 202 until the report exists.
router.get("/api/finalread/reports/:id", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const reportRow = await getReport(req.params.id);
  // The report id names the review through the stored row; an unknown id
  // is a 404. (A generating report has no row yet — the caller retries
  // with the review id instead; see GET /api/finalread/reviews/:id.)
  if (!reportRow) return res.status(404).json({ error: "Report not found." });
  const found = await getFinalReadReview(reportRow.review_id);
  if (!found) return res.status(404).json({ error: "Report not found." });
  const review = found.review;
  const isSeller = review.seller_user_id === userId;
  const isBuyer = await hasBuyerAccess(userId, review.id);
  const paid = !!review.purchase_stripe_event_id;
  if (!isBuyer && !(isSeller && paid)) {
    return res.status(403).json({ error: "This report is only available to the buyer who paid for it." });
  }
  res.json({
    report: parseJson(reportRow.report),
    reviewId: review.id,
    versionId: reportRow.version_id,
    reportId: reportRow.id,
  });
}));

// A review's latest report (the buyer's / seller's entry point after
// payment, and the "report is being generated" poll while a job runs).
router.get("/api/finalread/reviews/:id/report", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const found = await getFinalReadReview(req.params.id);
  if (!found) return res.status(404).json({ error: "Review not found." });
  const review = found.review;
  const isSeller = review.seller_user_id === userId;
  const isBuyer = await hasBuyerAccess(userId, review.id);
  const paid = !!review.purchase_stripe_event_id;
  if (!isBuyer && !(isSeller && paid)) {
    return res.status(403).json({ error: "This report is only available to the buyer who paid for it." });
  }
  const latest = await getLatestReportForReview(review.id);
  if (latest) {
    return res.json({
      report: parseJson(latest.report),
      reviewId: review.id,
      versionId: latest.version_id,
      reportId: latest.id,
    });
  }
  // No report yet: retry a pending/failed generation job, then report
  // the generating state instead of losing the buyer's report silently.
  const job = await getReportJobForReview(review.id);
  if (job && (job.status === "pending" || job.status === "failed")) {
    try {
      await processPendingReportJobs();
    } catch (err: any) {
      log.warn(`finalread report fetch: job retry failed: ${err?.message || err}`);
    }
    const retried = await getLatestReportForReview(review.id);
    if (retried) {
      return res.json({
        report: parseJson(retried.report),
        reviewId: review.id,
        versionId: retried.version_id,
        reportId: retried.id,
      });
    }
    return res.status(202).json({
      status: "generating",
      message: "The report is being generated. Please check back shortly.",
    });
  }
  return res.status(404).json({ error: "Report not found." });
}));

// A review with its full version history (spec §12.1, criterion 20):
// every version is preserved, never overwritten. Authorized: the seller
// or a paid buyer.
router.get("/api/finalread/reviews/:id", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const found = await getFinalReadReview(req.params.id);
  if (!found) return res.status(404).json({ error: "Review not found." });
  const review = found.review;
  const isSeller = review.seller_user_id === userId;
  const isBuyer = await hasBuyerAccess(userId, review.id);
  if (!isSeller && !isBuyer) {
    return res.status(404).json({ error: "Review not found." });
  }
  const versions = await getReviewVersions(review.id);
  const reports = await getReportsForReview(review.id);
  const reportByVersion = new Map(reports.map((r) => [r.version_id, r.id]));
  res.json({
    review: {
      id: review.id,
      projectId: review.project_id,
      sellerUserId: review.seller_user_id,
      purchaseStripeEventId: review.purchase_stripe_event_id,
      createdAt: review.created_at,
    },
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      contentHash: v.content_hash,
      reportId: reportByVersion.get(v.id) ?? null,
      createdAt: v.created_at,
    })),
  });
}));

// The Q&A log for a review (spec §5.6 option (a), CONFIRMED): the seller
// sees the full log; the buyer sees their own log. Read-only — asking is
// the paid buyer's /api/finalread/ask.
router.get("/api/finalread/reviews/:id/qa-log", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const found = await getFinalReadReview(req.params.id);
  if (!found) return res.status(404).json({ error: "Review not found." });
  const review = found.review;
  const isSeller = review.seller_user_id === userId;
  const isBuyer = await hasBuyerAccess(userId, review.id);
  if (!isSeller && !isBuyer) {
    return res.status(404).json({ error: "Review not found." });
  }
  const rows = await getQaHistoryForReview(review.id);
  res.json({
    reviewId: review.id,
    turns: rows.map((r) => ({
      question: r.question,
      answer: r.answer,
      citedFindings: parseJson<string[]>(r.cited_findings),
      createdAt: r.created_at,
    })),
  });
}));

export default router;
