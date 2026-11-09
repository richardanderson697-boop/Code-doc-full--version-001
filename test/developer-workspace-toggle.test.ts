// Shared FinalRead review — the toggle/adoption/gating decision layer.
// Pure functions only (src/utils/sharedReview.ts); no DOM, no network.
import { describe, it, expect } from "vitest";
import {
  createWorkspaceReview,
  createEntryReview,
  withIntelResult,
  withIntelError,
  withIntelStatus,
  reviewHasReport,
  showDeveloperWorkspaceToggle,
  entryViewFor,
  workspaceHeaderTitle,
  footerBrandFor,
  titleFromRepoUrl,
  titleFromZipName,
  type SharedReview,
} from "../src/utils/sharedReview";

const FAKE_RESULT = { completenessScore: 72, totalFiles: 20 };

function workspaceReviewWithResult(): SharedReview {
  return withIntelResult(createWorkspaceReview("RentStream"), FAKE_RESULT);
}

describe("createWorkspaceReview", () => {
  it("records a workspace origin with no result yet", () => {
    const r = createWorkspaceReview("my-app.zip");
    expect(r.source).toBe("workspace");
    expect(r.title).toBe("my-app.zip");
    expect(r.intelResult).toBeNull();
    expect(r.intelStatus).toBe("idle");
    expect(r.intelError).toBeUndefined();
  });

  it("falls back to the generic title for a blank title", () => {
    expect(createWorkspaceReview("").title).toBe("Your codebase");
    expect(createWorkspaceReview("   ").title).toBe("Your codebase");
  });
});

describe("createEntryReview", () => {
  it("records an entry origin with the finished result", () => {
    const r = createEntryReview("owner/repo", FAKE_RESULT);
    expect(r.source).toBe("entry");
    expect(r.title).toBe("owner/repo");
    expect(r.intelResult).toBe(FAKE_RESULT);
    expect(r.intelStatus).toBe("done");
  });

  it("falls back to the generic title for a blank title", () => {
    expect(createEntryReview("", FAKE_RESULT).title).toBe("Your codebase");
  });
});

describe("withIntelResult", () => {
  it("preserves source and title — a scan never re-originates a review", () => {
    const r = withIntelResult(createWorkspaceReview("RentStream"), FAKE_RESULT);
    expect(r.source).toBe("workspace");
    expect(r.title).toBe("RentStream");
    expect(r.intelResult).toBe(FAKE_RESULT);
    expect(r.intelStatus).toBe("done");
  });

  it("preserves an entry origin too", () => {
    const before = createEntryReview("owner/repo", null);
    const r = withIntelResult(before, FAKE_RESULT);
    expect(r.source).toBe("entry");
  });

  it("clears a previous scan error when the new scan succeeds", () => {
    const errored = withIntelError(createWorkspaceReview("RentStream"), "boom");
    const r = withIntelResult(errored, FAKE_RESULT);
    expect(r.intelStatus).toBe("done");
    expect(r.intelError).toBeUndefined();
  });

  it("does not mutate the input review", () => {
    const before = createWorkspaceReview("RentStream");
    const r = withIntelResult(before, FAKE_RESULT);
    expect(before.intelResult).toBeNull();
    expect(before.intelStatus).toBe("idle");
    expect(r).not.toBe(before);
  });
});

describe("withIntelError", () => {
  it("records the failure and keeps the last good report", () => {
    const done = workspaceReviewWithResult();
    const r = withIntelError(done, "scan failed");
    expect(r.intelStatus).toBe("error");
    expect(r.intelError).toBe("scan failed");
    expect(r.intelResult).toBe(FAKE_RESULT);
    expect(r.source).toBe("workspace");
  });
});

describe("withIntelStatus", () => {
  it("loading clears the previous result and error", () => {
    const errored = withIntelError(workspaceReviewWithResult(), "boom");
    const r = withIntelStatus(errored, "loading");
    expect(r.intelStatus).toBe("loading");
    expect(r.intelResult).toBeNull();
    expect(r.intelError).toBeUndefined();
    expect(r.source).toBe("workspace");
    expect(r.title).toBe("RentStream");
  });

  it("other statuses only move the status", () => {
    const r = withIntelStatus(createWorkspaceReview("RentStream"), "idle");
    expect(r.intelStatus).toBe("idle");
    expect(r.source).toBe("workspace");
  });
});

describe("reviewHasReport", () => {
  it("is true only for a finished result", () => {
    expect(reviewHasReport(workspaceReviewWithResult())).toBe(true);
    expect(reviewHasReport(createWorkspaceReview("RentStream"))).toBe(false);
    expect(reviewHasReport(null)).toBe(false);
    expect(reviewHasReport(undefined)).toBe(false);
  });

  it("is false when a result exists but the scan is not done", () => {
    const r: SharedReview = {
      source: "workspace",
      title: "x",
      intelResult: FAKE_RESULT,
      intelStatus: "loading",
    };
    expect(reviewHasReport(r)).toBe(false);
  });
});

describe("showDeveloperWorkspaceToggle — the buyer gate", () => {
  it("shows only for workspace-originated reviews", () => {
    expect(showDeveloperWorkspaceToggle(createWorkspaceReview("x"))).toBe(true);
    expect(showDeveloperWorkspaceToggle(workspaceReviewWithResult())).toBe(true);
  });

  it("hides for entry-originated reviews and for no review", () => {
    expect(showDeveloperWorkspaceToggle(createEntryReview("x", FAKE_RESULT))).toBe(false);
    expect(showDeveloperWorkspaceToggle(null)).toBe(false);
    expect(showDeveloperWorkspaceToggle(undefined)).toBe(false);
  });
});

describe("entryViewFor", () => {
  it("ingest when there is no review", () => {
    expect(entryViewFor(null)).toBe("ingest");
    expect(entryViewFor(undefined)).toBe("ingest");
  });

  it("continue when a review exists without a finished report", () => {
    expect(entryViewFor(createWorkspaceReview("x"))).toBe("continue");
    expect(entryViewFor(withIntelStatus(createWorkspaceReview("x"), "loading"))).toBe("continue");
    expect(entryViewFor(withIntelError(createWorkspaceReview("x"), "boom"))).toBe("continue");
  });

  it("report when a finished report exists, either origin", () => {
    expect(entryViewFor(workspaceReviewWithResult())).toBe("report");
    expect(entryViewFor(createEntryReview("x", FAKE_RESULT))).toBe("report");
  });
});

describe("rename strings", () => {
  it("workspace header reads FinalRead Developer Workspace", () => {
    expect(workspaceHeaderTitle(false)).toBe("FinalRead Developer Workspace");
    expect(workspaceHeaderTitle(true)).toBe("FinalRead");
  });

  it("footer brand follows the view", () => {
    expect(footerBrandFor(false)).toBe("FinalRead Developer Workspace");
    expect(footerBrandFor(true)).toBe("FinalRead");
  });

  it("the workspace footer brand is not the bare FinalRead brand, so the footer discovery link stays visible", () => {
    // Footer hides its FinalRead link only when brand === "FinalRead".
    expect(footerBrandFor(false)).not.toBe("FinalRead");
  });
});

describe("title derivation", () => {
  it("titleFromRepoUrl pulls owner/repo and strips .git", () => {
    expect(titleFromRepoUrl("https://github.com/richardanderson697-boop/Room2Room")).toBe(
      "richardanderson697-boop/Room2Room"
    );
    expect(titleFromRepoUrl("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(titleFromRepoUrl("https://github.com/owner/repo/tree/main")).toBe("owner/repo");
    expect(titleFromRepoUrl("https://github.com/owner/repo?tab=readme")).toBe("owner/repo");
  });

  it("titleFromRepoUrl falls back for non-GitHub URLs", () => {
    expect(titleFromRepoUrl("https://example.com/foo")).toBe("Your codebase");
    expect(titleFromRepoUrl("")).toBe("Your codebase");
    expect(titleFromRepoUrl("not a url")).toBe("Your codebase");
  });

  it("titleFromZipName strips .zip case-insensitively", () => {
    expect(titleFromZipName("my-app.zip")).toBe("my-app");
    expect(titleFromZipName("My-App.ZIP")).toBe("My-App");
    expect(titleFromZipName("my-app")).toBe("my-app");
    expect(titleFromZipName(".zip")).toBe("Your codebase");
  });
});
