// Whole-workspace project intelligence route.
import { Router } from "express";
import { asyncRoute } from "../async-route";
import { formatGeminiError } from "../gemini";
import { WorkspaceFile, cleanWorkspacePath, countLines } from "../workspace";
import { listWorkspaceFiles, getWorkspaceFile } from "../workspace-store";
import { log } from "../logger";
import { requireAuth, checkCredits, AuthedRequest } from "../middleware/requireAuth";
import { chargeForCall } from "../credits";
import { runIntelligenceScan } from "../intelligence-scan";
import {
  consumeRescanEntitlement,
  findLatestFinalReadPurchase,
  findUsableEntitlement,
  getFinalReadReview,
  getLatestReviewVersion,
  hashReviewContent,
  type FinalReadReviewRow,
  type RescanEntitlementRow,
  type ReviewVersionRow,
} from "../finalread-rescans";
import {
  createAuditSnapshot,
  createEntryReview,
  createProjectReview,
  createVersionReport,
  deletePendingAuditSnapshots,
  getFinalReadProject,
  getPendingAuditSnapshot,
  hasBuyerAccess,
  setProjectReview,
  type AuditSnapshotRow,
  type FinalReadProjectRow,
} from "../finalread-projects";
import { getDb } from "../store";

const router = Router();

// Bounds for client-supplied intelligence sources. The workspace ZIP path
// already has its own limits; these cover the virtual-file and selected-path
// variants so one request cannot blow up memory.
const MAX_INTEL_FILES = 200;
const MAX_INTEL_FILE_BYTES = 1024 * 1024;
const MAX_INTEL_TOTAL_BYTES = 5 * 1024 * 1024;


// The credit gate lives INSIDE this handler, not in requireCredits
// middleware: a FinalRead re-scan covered by an entitlement — or a re-run
// of unchanged code — skips the gate entirely, and that decision needs
// the resolved files (the content hash) before it can be made. The gate
// itself is unchanged (min balance 40, same 402 shape) for every
// credit-charged run. A seller's initial scan of a saved FinalRead project
// skips the gate too (spec §7.1, §10) — but only when all four conditions
// hold (draft project, caller is the seller, no review yet, server-loaded
// saved files); anything else pays the normal gate.
router.post("/api/project-intelligence", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  try {
    const userId = req.user!.id;
    const body = (req.body as any) ?? {};
    // A re-scan must carry the project id (spec §11) — checked before any
    // file resolution, so the answer is a 400 whether or not the caller
    // has workspace files of their own.
    const finalreadReviewIdEarly =
      typeof body.finalreadReviewId === "string" && body.finalreadReviewId.trim()
        ? body.finalreadReviewId.trim()
        : undefined;
    const projectIdEarly =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : undefined;
    if (finalreadReviewIdEarly && !projectIdEarly) {
      // Entry-flow reviews have no project: a re-run names only the
      // review id. The project-id requirement binds PROJECT re-scans to
      // their saved project; an entry review (project_id NULL) has no
      // project to bind to, and the FinalRead decision below still
      // authorizes the caller (seller or paid buyer) and 404s strangers —
      // so this only lets a known entry review past the fast-fail.
      // (Build decision: the entry re-run previously 400d here, which
      // blocked the paid re-scan for entry reviews — gate spec §8.)
      const entryReview = await getFinalReadReview(finalreadReviewIdEarly);
      if (!entryReview || entryReview.review.project_id) {
        return res.status(400).json({ error: "A re-scan must carry the project id." });
      }
    }

    // Project binding (spec §7.1, §11). A projectId routes the scan
    // through the seller's saved project, loaded server-side from the
    // SELLER's workspace — whoever the caller is (a buyer re-scanning
    // reads the seller's code, never their own workspace and never a
    // client-supplied source). The fetch is deliberately NOT owner-scoped
    // here: authorization happens in the FinalRead decision below, via
    // the review (the seller or a paid buyer); the seller-only project
    // endpoints in routes/finalread-projects.ts stay owner-scoped.
    let project: FinalReadProjectRow | undefined;
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : undefined;
    if (projectId) {
      project = await getFinalReadProject(projectId);
      if (!project) return res.status(404).json({ error: "Project not found." });
      // A project scan never takes a client-supplied source: the buyer
      // never supplies a path or code, and the seller's initial scan runs
      // from the saved project files only. Client-supplied codeFiles or
      // paths with a projectId are rejected, not silently ignored (§11).
      if (Array.isArray(body.codeFiles) && body.codeFiles.length > 0) {
        return res.status(400).json({
          error: "A project scan runs from the saved project files; codeFiles are not accepted with a projectId.",
        });
      }
      if (Array.isArray(body.paths) && body.paths.length > 0) {
        return res.status(400).json({
          error: "A project scan runs from the saved project files; paths are not accepted with a projectId.",
        });
      }
    }

    // Source selection, in priority order. The client may name the exact
    // source it wants scored; the server never guesses.
    let files: WorkspaceFile[] = [];
    // Only the whole-workspace run may donate a README title or an import
    // source to the report header: selected paths and pasted code are
    // fragments, and their README (if any) is not the project's identity.
    let fromWorkspace = false;

    if (project) {
      // 0. A project scan: the seller's saved project files, loaded
      //    server-side from the SELLER's workspace. Nothing client-supplied
      //    reaches the scan.
      const saved = await listWorkspaceFiles(project.seller_user_id);
      if (saved.length > 0) {
        files = saved.map((f) => ({ path: f.path, content: f.content, lineCount: f.lineCount }));
        fromWorkspace = true;
      }
    } else if (Array.isArray(body.codeFiles) && body.codeFiles.length > 0) {
      // 1. codeFiles: raw code supplied by the client (e.g. the active editor
      //    code). Virtual files: the path is a display label only, the content
      //    never touches disk.
      if (body.codeFiles.length > MAX_INTEL_FILES) {
        return res.status(400).json({ error: `Too many files (limit ${MAX_INTEL_FILES}).` });
      }
      let totalChars = 0;
      for (const f of body.codeFiles) {
        if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
          return res.status(400).json({ error: "Each code file needs a string path and string content." });
        }
        if (f.content.length > MAX_INTEL_FILE_BYTES) {
          return res.status(400).json({ error: "One file exceeds the 1MB per-file limit." });
        }
        totalChars += f.content.length;
        if (totalChars > MAX_INTEL_TOTAL_BYTES) {
          return res.status(400).json({ error: "Files exceed the 5MB total limit." });
        }
        const label = f.path.trim().replace(/^\/+/, "").replace(/\.\./g, "").slice(0, 300) || "pasted-code.txt";
        files.push({ path: label, content: f.content, lineCount: countLines(f.content) });
      }
    } else if (Array.isArray(body.paths) && body.paths.length > 0) {
      // 2. paths: selected files from the user's own uploaded workspace,
      //    resolved strictly inside their per-user directory.
      if (body.paths.length > MAX_INTEL_FILES) {
        return res.status(400).json({ error: `Too many files (limit ${MAX_INTEL_FILES}).` });
      }
      for (const p of body.paths) {
        if (typeof p !== "string" || p.length === 0) {
          return res.status(400).json({ error: "Invalid file path." });
        }
        const relPath = cleanWorkspacePath(p);
        const row = relPath ? await getWorkspaceFile(userId, relPath) : undefined;
        if (!row) {
          return res.status(400).json({ error: `Unknown workspace file: ${p.slice(0, 120)}` });
        }
        const content = row.content;
        if (content.length > MAX_INTEL_FILE_BYTES) {
          return res.status(400).json({ error: "One file exceeds the 1MB per-file limit." });
        }
        files.push({ path: relPath!, content, lineCount: countLines(content) });
      }
    } else {
      // 3. The whole uploaded workspace.
      const scannedFiles = await listWorkspaceFiles(userId);
      if (scannedFiles.length > 0) {
        files = scannedFiles.map((f) => ({ path: f.path, content: f.content, lineCount: f.lineCount }));
        fromWorkspace = true;
      }
    }

    // There is deliberately no fallback to the application's own directory.
    // An earlier version scanned process.cwd() with an exclusion list, which
    // silently graded GradeVibes' own source (test/, scripts/, ...) as the
    // user's project whenever no upload existed. No upload and no explicit
    // source means there is nothing of the user's to score.
    if (files.length === 0) {
      return res.status(200).json({
        notEnoughFiles: true,
        error: "Not enough files to run scan on your codebase. Upload a ZIP of your codebase, select a file, or generate code first!"
      });
    }

    // FinalRead decision (spec §7.1, §11). A call from the FinalRead entry
    // carries `finalread: true` on the first review, or
    // `finalreadReviewId` on a re-run of a review the server already
    // created. A project scan is always a FinalRead call. Workspace scans
    // never send either and never touch this.
    //
    // - Identical code (hash matches the frozen version / pending audit)
    //   is not a re-scan: no model call, no charge, no entitlement
    //   consumed — the caller is told the code is unchanged and the
    //   previous report still stands.
    // - Changed code with a usable entitlement is covered: no credit gate,
    //   no charge; one entitlement is consumed when the scan succeeds
    //   (at the charge site below, mirroring the existing charge-on-model-
    //   success behavior — a failed scan consumes nothing).
    // - Changed code without one falls back to the normal credit path.
    // - A re-scan must carry the project id, and the server verifies the
    //   project exists, the review belongs to it, and the caller is the
    //   seller or a paid buyer. An unknown review id, or someone else's
    //   review, is a 404 — never silently treated as a first review (that
    //   was the cross-app hole: a different app's code plus a usable
    //   entitlement read as a free re-scan and overwrote the frozen hash).
    const finalreadReviewId =
      typeof body.finalreadReviewId === "string" && body.finalreadReviewId.trim()
        ? body.finalreadReviewId.trim()
        : undefined;
    const isFinalReadCall =
      body.finalread === true || finalreadReviewId !== undefined || project !== undefined;
    let review: FinalReadReviewRow | undefined;
    let latestVersion: ReviewVersionRow | undefined;
    let pendingSnapshot: AuditSnapshotRow | undefined;
    let usableEntitlement: RescanEntitlementRow | undefined;
    let rescanCovered = false;
    // The hash of exactly the files this scan grades, reused by the
    // frozen-version bookkeeping after a successful scan.
    let contentHash: string | undefined;
    // Which FinalRead shape this call is (exactly one is true per call):
    let isProjectInitialScan = false;
    let isInitialScanRerun = false;
    let isRescan = false;
    // The seller's initial scan of a saved project is free — but ONLY when
    // all four conditions hold (spec §7.1, §10): (a) the request carries a
    // projectId for a saved FinalRead project in draft, (b) the caller IS
    // the seller (enforced by the owner-scoped project fetch above),
    // (c) the scan is the INITIAL scan (the project has no review yet),
    // (d) the source is the seller's saved project files loaded
    // server-side (enforced by the projectId path rejecting client files).
    let freeSellerScan = false;

    if (isFinalReadCall) {
      contentHash = hashReviewContent(files);
      if (finalreadReviewId) {
        // Explicit re-scan by review id. (The project-id requirement is
        // enforced before file resolution, above.)
        const found = await getFinalReadReview(finalreadReviewId);
        if (found) {
          const isSeller = found.review.seller_user_id === userId;
          const isBuyer = await hasBuyerAccess(userId, finalreadReviewId);
          if (isSeller || isBuyer) {
            review = found.review;
            latestVersion = found.version;
          }
        }
        if (!review) {
          return res.status(404).json({ error: "Review not found." });
        }
        // NULL (an entry-flow review, no project) and undefined (no
        // projectId in the request) both mean "no project" — compare them
        // as equal, or every entry re-run 400s here.
        if ((review.project_id ?? undefined) !== projectId) {
          return res.status(400).json({ error: "That review does not belong to this project." });
        }
        pendingSnapshot = await getPendingAuditSnapshot(review.id);
        isRescan = latestVersion !== undefined;
        isInitialScanRerun = latestVersion === undefined;
      } else if (project) {
        // A project scan without a review id: the initial scan, or a
        // re-run of it (the seller re-scanning before payment). Only the
        // project owner may scan without naming a review — a buyer names
        // the review they paid for.
        if (project.seller_user_id !== userId) {
          return res.status(404).json({ error: "Project not found." });
        }
        if (project.finalread_review_id) {
          const found = await getFinalReadReview(project.finalread_review_id);
          if (found) {
            review = found.review;
            latestVersion = found.version;
            pendingSnapshot = await getPendingAuditSnapshot(review.id);
            isRescan = latestVersion !== undefined;
            isInitialScanRerun = latestVersion === undefined;
          }
        }
        if (!review) {
          isProjectInitialScan = true;
          freeSellerScan = project.status === "draft";
        }
      }
      // Identical code is not a re-scan: no model call, no charge, no
      // entitlement consumed. Compared against the frozen version when
      // the review is paid, the pending audit when it is not.
      const frozenHash = latestVersion?.content_hash ?? pendingSnapshot?.content_hash;
      if (frozenHash && contentHash === frozenHash && review) {
        return res.status(200).json({
          codeUnchanged: true,
          finalreadReviewId: review.id,
          message:
            "The code hasn't changed since the last review — no re-scan needed. Your previous report still stands.",
        });
      }
      if (isRescan) {
        usableEntitlement = await findUsableEntitlement(userId);
        rescanCovered = usableEntitlement !== undefined;
      }
    }

    // The credit gate, for credit-charged runs only. Entitlement-covered
    // re-scans skip it (a buyer with 0 credits and a re-scan left can
    // still re-scan); a seller's free initial project scan skips it;
    // identical-code re-runs never reach here.
    if (!rescanCovered && !freeSellerScan) {
      const check = await checkCredits(userId, "intelligence");
      // NB: `check.ok === false` (not `!check.ok`): this codebase is not
      // strict-mode, and the truthiness form does not narrow the union.
      if (check.ok === false) return res.status(402).json(check.body);
    }

    // The scan itself (PreFlight + deterministic assessment + model call +
    // citation verification). The route keeps the charging and the
    // frozen-version bookkeeping; the scan lives in intelligence-scan.ts
    // so the server-side re-scan job can run the same scan.
    const scan = await runIntelligenceScan(files, { userId, fromWorkspace });

    // Payment for the run: an entitlement-covered re-scan consumes one
    // entitlement instead of charging credits (atomic decrement — a lost
    // race falls back to the credit charge below). A seller's free initial
    // project scan is charged to nobody. Every other run charges the
    // metered cost as before. A failed model call never reaches here,
    // so neither a charge nor a consumption happens on an outage.
    let intelBalance: number | null = null;
    let rescanEntitlementUsed = false;
    let rescanEntitlementsRemaining: number | undefined;
    if (rescanCovered && usableEntitlement) {
      rescanEntitlementUsed = await consumeRescanEntitlement(usableEntitlement.id);
      if (rescanEntitlementUsed) {
        rescanEntitlementsRemaining = usableEntitlement.remaining - 1;
      }
    }
    if (!rescanEntitlementUsed && !freeSellerScan) {
      intelBalance = await chargeForCall(userId, scan.usage, scan.modelName, "project intelligence");
      if (intelBalance != null) res.set("X-Credits-Balance", String(intelBalance));
    }

    const parsedIntel = scan.audit;
    // FinalRead bookkeeping, after a successful scan only. A re-scan's new
    // code becomes a NEW immutable version; a first review freezes its
    // first version and hands the client the review id so later re-runs
    // can name it. A failed scan never reaches here, so a failed re-scan
    // never advances the frozen version or spends anything.
    if (isFinalReadCall && contentHash) {
      if (isProjectInitialScan && project) {
        // The review is created with NO version row: version 1 is created
        // at payment time from this pending snapshot (spec §5.2). The
        // seller sees the developer view (this scan result); the full
        // report + Q&A are paid-only.
        const newReview = await createProjectReview(project.id, userId);
        await createAuditSnapshot({
          reviewId: newReview.id,
          versionId: null,
          audit: parsedIntel,
          contentHash,
          status: "pending",
        });
        await setProjectReview(project.id, newReview.id);
        parsedIntel.finalreadReviewId = newReview.id;
        parsedIntel.projectId = project.id;
      } else if (isInitialScanRerun && review) {
        // The seller re-ran the initial scan before payment: the pending
        // audit is replaced (the seller has not paid yet, so the pending
        // audit is not a paid artifact and the newest scan is the pinned
        // assessment). Still gated + charged like any other scan — the
        // free boundary is the FIRST scan only (finalread_review_id NULL).
        await deletePendingAuditSnapshots(review.id);
        await createAuditSnapshot({
          reviewId: review.id,
          versionId: null,
          audit: parsedIntel,
          contentHash,
          status: "pending",
        });
        parsedIntel.finalreadReviewId = review.id;
        parsedIntel.projectId = review.project_id;
      } else if (isRescan && review) {
        // A re-scan creates a NEW immutable version (snapshot + version +
        // report), never an update to the frozen one (§12).
        const latest = await getLatestReviewVersion(review.id);
        const versionNumber = latest ? latest.version_number + 1 : 1;
        const { version, report } = await createVersionReport(getDb(), {
          reviewId: review.id,
          projectId: review.project_id,
          versionNumber,
          contentHash,
          audit: parsedIntel,
          stripeEventId: review.purchase_stripe_event_id,
        });
        parsedIntel.finalreadReviewId = review.id;
        parsedIntel.finalreadVersionId = version.id;
        parsedIntel.finalreadReportId = report.id;
        parsedIntel.projectId = review.project_id;
      } else if (body.finalread === true) {
        // Entry flow (no project): the review is created with NO version
        // row, and the scan's audit is stored as a PENDING audit keyed by
        // this review id (gate spec §5 — the same pending-audit mechanism
        // as a project initial scan). Version 1 + the report are created
        // at payment time from the pending audit, so the report can be
        // generated without a second scan. The caller already holding a
        // $199 purchase is recorded from creation (as before); a purchase
        // that lands after the scan is claimed at the first paid report
        // fetch (generateReportForPaidEntryReview).
        const purchaseEventId = await findLatestFinalReadPurchase(userId);
        const newReview = await createEntryReview(userId, purchaseEventId);
        await createAuditSnapshot({
          reviewId: newReview.id,
          versionId: null,
          audit: parsedIntel,
          contentHash,
          status: "pending",
        });
        parsedIntel.finalreadReviewId = newReview.id;
      }
      parsedIntel.rescanEntitlementUsed = rescanEntitlementUsed;
      if (rescanEntitlementsRemaining !== undefined) {
        parsedIntel.rescanEntitlementsRemaining = rescanEntitlementsRemaining;
      }
    }
    res.json(parsedIntel);
  } catch (error: any) {
    log.error("Project Intelligence API Error:", error);
    // The deterministic scan runs before the model call, so a model outage
    // still hands the client the findings instead of a bare error (same
    // contract as before — the scan attaches them to the thrown error).
    const calibratedPreflight = (error as any)?.calibratedPreflight;
    const preflight = (error as any)?.preflight;
    res.status(500).json({
      error: formatGeminiError(error),
      ...(calibratedPreflight ? { preflight: calibratedPreflight } : preflight ? { preflight } : {}),
    });
  }
}));

export default router;
