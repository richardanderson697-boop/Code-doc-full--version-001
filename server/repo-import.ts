// GitHub repo-URL import helpers — pure functions, no DB or Express imports
// so they can be unit-tested in isolation.
//
// Security model: the pasted URL is NEVER fetched directly. It is parsed,
// the owner/repo are extracted, and the fetch target is BUILT from those
// validated components against a fixed host. Redirects are followed manually
// against an allowlist. This makes SSRF impossible by construction: there is
// no path from user input to the fetch target's host.

export interface ParsedRepo {
  owner: string;
  repo: string;
}

/** Parse a pasted repository URL. Only https://github.com/<owner>/<repo> is
 *  accepted in v1 (public repos). Returns null for anything else. */
export function parseGitHubRepoUrl(input: unknown): ParsedRepo | null {
  if (typeof input !== "string") return null;
  let raw = input.trim();
  // Mobile pastes and typed URLs often omit the scheme — assume https.
  if (raw && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    raw = "https://" + raw;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return null;
  }
  // Accept /owner/repo plus any trailing path (e.g. /tree/main, /issues) —
  // only the first two segments are used to build the archive URL.
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** Validate an optional branch/tag ref. Conservative charset, no traversal. */
export function isValidRef(ref: unknown): ref is string {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= 128 &&
    /^[A-Za-z0-9_.\-/]+$/.test(ref) &&
    !ref.includes("..")
  );
}

/** Build the archive download URL from VALIDATED components only. */
export function buildArchiveUrl(owner: string, repo: string, branch: string): string {
  return `https://github.com/${owner}/${repo}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
}

/** Hosts a redirect may legally land on during the archive fetch. */
export function isAllowedFetchHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "codeload.github.com";
}
