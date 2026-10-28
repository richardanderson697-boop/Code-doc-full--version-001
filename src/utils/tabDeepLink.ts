// Deep-link into the workspace tabs: ?tab=upload opens the Upload ZIP
// Codebase tab, where the GitHub repo URL import lives. Anything else
// keeps the default New App Builder tab. Pure function over the query
// string so it can be unit-tested in isolation; Facebook appends its own
// fbclid param alongside, in either order, which URLSearchParams handles.
export type WorkspaceTab = "generate" | "audit" | "zip";

export function initialTabFromSearch(search: string): WorkspaceTab {
  try {
    return new URLSearchParams(search).get("tab") === "upload"
      ? "zip"
      : "generate";
  } catch {
    return "generate";
  }
}
