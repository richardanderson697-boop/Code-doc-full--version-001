// Shared FinalRead review: the single review both the Developer Workspace
// and the FinalRead entry read. It lives in App state (in-memory, for the
// session only — a reload still loses it, by design for v1) so toggling
// between the two views never re-uploads, re-scans, or re-charges.
//
// The review records where the upload originated, because that decides the
// gate: a workspace-originated review toggles both ways with full workspace
// access; an entry-originated (buyer-flow) review never lands in the
// workspace UI — the buyer gets findings only, never the code. The origin is
// recorded at upload/scan time and never changed by toggling.
//
// Everything here is pure and UI-free so it can be unit-tested without a
// DOM; the components consume it (App holds the state, CodeAuditor and
// FinalReadEntry read and write it through props).

export type SharedReviewSource = "workspace" | "entry";

export type SharedReviewIntelStatus = "idle" | "loading" | "done" | "error";

export interface SharedReview {
  /** Where the upload originated. Never changed by toggling. */
  source: SharedReviewSource;
  /** ZIP filename or owner/repo. */
  title: string;
  /** The /api/project-intelligence response, or null if no scan has run yet. */
  intelResult: any | null;
  intelStatus: SharedReviewIntelStatus;
  /** Scan failure message, when intelStatus is "error". */
  intelError?: string;
}

/** A workspace upload starts a review with no scan result yet. */
export function createWorkspaceReview(title: string): SharedReview {
  return {
    source: "workspace",
    title: title && title.trim() ? title : "Your codebase",
    intelResult: null,
    intelStatus: "idle",
  };
}

/** A completed entry (buyer-flow) scan creates its review with the result. */
export function createEntryReview(title: string, intelResult: any): SharedReview {
  return {
    source: "entry",
    title: title && title.trim() ? title : "Your codebase",
    intelResult: intelResult ?? null,
    intelStatus: "done",
  };
}

/** Record a finished scan into an existing review. Source and title are
 *  preserved — a scan never re-originates a review. */
export function withIntelResult(review: SharedReview, intelResult: any): SharedReview {
  const next = { ...review, intelResult: intelResult ?? null, intelStatus: "done" as const };
  delete next.intelError;
  return next;
}

/** Record a failed scan. The previous result (if any) is kept: a failed
 *  re-scan does not destroy the last good report. */
export function withIntelError(review: SharedReview, message: string): SharedReview {
  return { ...review, intelStatus: "error" as const, intelError: message };
}

/** Move a review to a scan status. Starting a scan ("loading") clears the
 *  previous result and error, so a stale report can never be shown as the
 *  result of the scan now running. */
export function withIntelStatus(
  review: SharedReview,
  status: SharedReviewIntelStatus
): SharedReview {
  if (status === "loading") {
    return { source: review.source, title: review.title, intelResult: null, intelStatus: "loading" };
  }
  return { ...review, intelStatus: status };
}

/** True when the review carries a finished report the entry can render. */
export function reviewHasReport(review: SharedReview | null | undefined): boolean {
  return review != null && review.intelResult != null && review.intelStatus === "done";
}

/** The "Developer workspace" toggle in the FinalRead entry is visible only
 *  for workspace-originated reviews. A buyer who only ever used the entry
 *  has no workspace review and sees no toggle. */
export function showDeveloperWorkspaceToggle(
  review: SharedReview | null | undefined
): boolean {
  return review?.source === "workspace";
}

/** Which face the FinalRead entry shows for a review. */
export type EntryView = "ingest" | "continue" | "report";

export function entryViewFor(review: SharedReview | null | undefined): EntryView {
  if (review == null) return "ingest";
  if (reviewHasReport(review)) return "report";
  return "continue";
}

/** Workspace header title: the rename. The entry side keeps "FinalRead". */
export function workspaceHeaderTitle(finalreadEntryOpen: boolean): string {
  return finalreadEntryOpen ? "FinalRead" : "FinalRead Developer Workspace";
}

/** Footer brand follows the view, as before — the workspace side now reads
 *  "FinalRead Developer Workspace" instead of the "GradeVibes" default.
 *  The footer's FinalRead discovery link hides only for brand "FinalRead",
 *  so it stays visible in the workspace view. */
export function footerBrandFor(finalreadEntryOpen: boolean): string {
  return finalreadEntryOpen ? "FinalRead" : "FinalRead Developer Workspace";
}

/** Owner/repo from a GitHub URL, matching the entry's existing derivation.
 *  Falls back to the generic title for anything that is not a GitHub URL. */
export function titleFromRepoUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+\/[^/?#]+)/i);
  const title = m ? m[1].replace(/\.git$/i, "") : "";
  return title ? title : "Your codebase";
}

/** ZIP filename without the extension, matching the entry's derivation. */
export function titleFromZipName(fileName: string): string {
  const title = fileName.replace(/\.zip$/i, "");
  return title ? title : "Your codebase";
}
