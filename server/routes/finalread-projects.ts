// FinalRead two-sided flow: the project workspace API (spec Revision 3,
// §2–§4). Seller-owned projects bound to a buyer-created review request,
// the buyer request endpoints, the paid report, and the Q&A log.
//
// Access rules (spec §4j, resource-level authorization — one ordinary
// account session, no distinct buyer session type):
// - A project belongs to its seller: another user gets a 404, never a leak.
// - A project save requires a valid buyer review-request code (the atomic
//   bind, §4b); a save without one is rejected.
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
  createProjectWithRequest,
  createReviewRequest,
  generateReportForPaidEntryReview,
  getFinalReadProjectForSeller,
  getLatestReportForReview,
  getQaHistoryForReview,
  getReport,
  getReportJobForReview,
  getReportsForReview,
  getRequestForProject,
  hasBuyerAccess,
  listFinalReadProjects,
  listReviewRequests,
  parseJson,
  processPendingReportJobs,
  rebindProjectRequest,
  ReviewRequestRateLimitedError,
  validateReviewRequestCode,
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
    requestId: project.request_id ?? null,
    scanInProgressAt: project.scan_in_progress_at ?? null,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

/** A review request as the buyer sees it. The code is NEVER returned here — it is shown once, at creation. */
function reviewRequestShape(row: any) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    projectId: row.project_id,
    expiresAt: row.expires_at,
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

// ---- Review requests (buyer creates, seller binds) ----

// Create a review request (two-sided flow §4a, §3 step 2): the buyer
// names the deal and gets the 8-character code ONCE (with a copy button
// in the client). The buyer shares it with the seller, who saves the
// project against it. Only the hash is stored — a lost code cannot be
// recovered; the buyer creates a new request. Rate limits (§4a): max 3
// unbound requests, max 5 created per day — over either is a 429.
router.post("/api/finalread/review-requests", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "Name the deal for this review." });
  if (title.length > 200) return res.status(400).json({ error: "Title is too long." });
  try {
    const { code, row } = await createReviewRequest(req.user!.id, title);
    res.status(201).json({ code, request: reviewRequestShape(row) });
  } catch (err: any) {
    if (err instanceof ReviewRequestRateLimitedError) {
      return res.status(429).json({ error: err.message });
    }
    throw err;
  }
}));

// The buyer's own review requests (no codes — the code is shown once,
// at creation).
router.get("/api/finalread/review-requests", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const rows = await listReviewRequests(req.user!.id);
  res.json({ requests: rows.map(reviewRequestShape) });
}));

// ---- Projects (seller-only) ----

// Save a project in the seller's workspace (spec §2 step 3,
// save-before-scan: the seller uploads code, saves the project against
// the buyer's review-request code, then runs the initial scan FROM the
// saved project). The save BINDS the code atomically (§4b): a save
// WITHOUT a valid request code is rejected with the same generic
// message for every failure mode — no enumeration of whether the code
// exists, is expired, is already bound, or belongs to the seller.
router.post("/api/finalread/projects", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "A project title is required." });
  if (title.length > 200) return res.status(400).json({ error: "Title is too long." });
  const requestCode = typeof req.body?.requestCode === "string" ? req.body.requestCode : "";
  if (!requestCode.trim()) {
    return res.status(400).json({ error: "A review request code is required. Ask the buyer for the code they created." });
  }
  const project = await createProjectWithRequest(req.user!.id, title, requestCode);
  if (!project) {
    return res.status(400).json({ error: "That review request code isn't valid. Ask the buyer for the code they created." });
  }
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

// One project, with its review + version summary and its bound review
// request. The report CONTENT is not included here — it is fetched
// separately, paid-only.
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
  const bound = await getRequestForProject(project.id);
  res.json({
    project: projectShape(project),
    review,
    versions,
    request: bound ? reviewRequestShape(bound) : null,
  });
}));

// Re-bind a DRAFT project to a different review-request code before
// payment (§4b). Blocked with a 409 while the bound request has an
// active checkout reservation.
router.post("/api/finalread/projects/:id/re-bind", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const requestCode = typeof req.body?.requestCode === "string" ? req.body.requestCode : "";
  if (!requestCode.trim()) {
    return res.status(400).json({ error: "A review request code is required." });
  }
  const result = await rebindProjectRequest(req.params.id, req.user!.id, requestCode);
  if (result === "not-found") return res.status(404).json({ error: "Project not found." });
  if (result === "reserved") {
    return res.status(409).json({ error: "A buyer is checking out on this project right now. Try again after their checkout expires." });
  }
  if (result === "invalid-code") {
    return res.status(400).json({ error: "That review request code isn't valid. Ask the buyer for the code they created." });
  }
  const project = await getFinalReadProjectForSeller(req.params.id, req.user!.id);
  res.json({ project: project ? projectShape(project) : null });
}));

// Close (soft-delete) a project (spec §7.2). The paid report, buyer
// access, Q&A history, audit snapshots, and version rows are retained
// independently and survive closure; only unactivated review requests
// are revoked. A hard delete of the code is out of scope. Closing a
// project with an active checkout reservation is a 409 (§4i case 3).
router.post("/api/finalread/projects/:id/close", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const result = await closeFinalReadProject(req.params.id, req.user!.id);
  if (result === "not-found") return res.status(404).json({ error: "Project not found." });
  if (result === "reserved") {
    return res.status(409).json({ error: "A buyer is checking out on this project right now. Try again after their checkout expires." });
  }
  res.json({ closed: true });
}));

// ---- Review-request code validation (buyer enters the code) ----

// Seller-issued invite-code endpoints are SUPERSEDED by the two-sided
// flow (§4a): the buyer creates the request and its code, the seller
// binds a project to it. There is no seller-issued code, no code list,
// and no standalone revoke endpoint anymore.

// A buyer enters a code (auth required: the buyer signs in first, then
// enters the code). Every failure returns the same generic shape — no
// enumeration of whether a code exists, is expired, or is already used.
// Valid ONLY when bound to a project WITH a pending audit (§4a).
router.post("/api/finalread/invite-codes/validate", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!code.trim()) return res.status(400).json({ error: "An invite code is required." });
  const result = await validateReviewRequestCode(code, req.user!.id);
  if (!result.valid) {
    return res.json({ valid: false });
  }
  res.json({
    valid: true,
    activatedForCaller: result.activatedForCaller,
    projectTitle: result.project?.title ?? null,
    projectId: result.project?.id ?? null,
    reviewId: result.project?.finalread_review_id ?? null,
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
  if (!isSeller && !isBuyer) {
    // A buyer with access to one review gets a 404 on another review's
    // report (two-sided flow §9 item 16): existence is hidden.
    return res.status(404).json({ error: "Report not found." });
  }
  if (isSeller && !paid) {
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
  let review = found.review;
  const isSeller = review.seller_user_id === userId;
  const isBuyer = await hasBuyerAccess(userId, review.id);
  // Lazy entry-report generation (gate spec §5): an entry-flow review
  // has no project and no invite code, so no webhook generates its
  // report. The first paid fetch generates it from the stored pending
  // audit — the payment-time trigger for the entry flow. A seller who
  // has not paid gets nothing generated (the helper returns undefined)
  // and the 403 below still answers.
  if (isSeller && !review.project_id) {
    const generated = await generateReportForPaidEntryReview(review.id, userId);
    if (generated) {
      const refound = await getFinalReadReview(review.id);
      if (refound) review = refound.review;
    }
  }
  const paid = !!review.purchase_stripe_event_id;
  if (!isSeller && !isBuyer) {
    // A buyer with access to one review gets a 404 on another review's
    // report (two-sided flow §9 item 16): existence is hidden.
    return res.status(404).json({ error: "Report not found." });
  }
  if (isSeller && !paid) {
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
