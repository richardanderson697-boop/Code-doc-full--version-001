// Uploaded-workspace file helpers: strict path containment and the
// recursive source-file scanner shared by the upload and audit routes.
import path from "path";

export const UPLOADED_DIR_NAME = "uploaded_project";

// Resolved per call and overridable by CODEDOC_UPLOAD_DIR so tests never touch
// a real workspace.
//
// Tenant isolation: every user's files live under their own subdirectory of
// the base dir (uploaded_project/<userId>/). The workspace routes were
// originally a single global directory, which meant any visitor could read or
// delete any other user's uploaded codebase. Never serve the base dir itself
// for a signed-in user: without a userId there is no owner, and ownerless
// data is exactly the hole being closed here.
export function uploadedDir(userId?: string): string {
  const base = process.env.CODEDOC_UPLOAD_DIR || path.join(process.cwd(), UPLOADED_DIR_NAME);
  if (!userId) return base;
  // User ids are server-generated hex, but sanitize anyway: a directory name
  // must never be influenced by unsanitized input.
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new Error("uploadedDir: invalid user id");
  return path.join(base, safe);
}

// 3.95. Workspace Project Intelligence Endpoint (Full Workspace Analyzer)

export interface WorkspaceFile {
  path: string;
  content: string;
  lineCount: number;
}

// Line count with no phantom lines: an empty file is 0 lines, and a trailing
// newline does not create an extra line. (content.split("\n").length reports
// 1 for "" and N+1 for N lines ending in "\n" — every report we emit was off
// by one because of this.)
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const withoutTrailing = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutTrailing.split("\n").length;
}

// Resolve a client-supplied path strictly inside `baseDir`. Returns null for
// anything that would land on or outside the base directory: absolute paths,
// ".." segments, or a prefix sibling like "uploaded_project-evil" (which a
// bare startsWith(baseDir) check would wave through).
export function resolveInsideDir(baseDir: string, userPath: unknown): string | null {
  if (typeof userPath !== "string" || userPath.length === 0 || userPath.includes("\0")) {
    return null;
  }
  let cleaned = userPath.trim();
  while (cleaned.startsWith("/") || cleaned.startsWith("\\")) {
    cleaned = cleaned.substring(1);
  }
  const resolved = path.resolve(baseDir, cleaned);
  const rel = path.relative(baseDir, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

// Source-code extensions the workspace tracks. Mirrors the old on-disk
// scanner: only these are listed, scored, or zipped. .sql is included so
// schema/migration files (e.g. RLS policies) reach the model instead of
// being guessed from missing input.
export const WORKSPACE_FILE_EXTS = [".ts", ".tsx", ".json", ".js", ".jsx", ".css", ".html", ".md", ".sql"];

export function isWorkspaceFileExt(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  const ext = dot >= 0 ? relPath.slice(dot).toLowerCase() : "";
  return WORKSPACE_FILE_EXTS.includes(ext);
}

// Paths the old on-disk scanner skipped (vendored/derived artifacts).
// Applied at ZIP ingest so junk is never stored.
export function isIgnorableWorkspacePath(relPath: string): boolean {
  return (
    relPath.startsWith("node_modules") ||
    relPath.startsWith(".git") ||
    relPath.startsWith("dist") ||
    relPath.startsWith("data") ||
    relPath.startsWith("assets") ||
    relPath.includes("bun.lock") ||
    relPath.includes("package-lock.json") ||
    relPath.includes("yarn.lock")
  );
}

// Lexical path cleaning for DB-backed storage. The database has no
// directories, so containment is enforced on the path string itself: no
// absolute paths, no ".." escapes (even ones that would resolve inside),
// no empty segments. Returns the canonical forward-slash path or null.
export function cleanWorkspacePath(userPath: unknown): string | null {
  if (typeof userPath !== "string" || userPath.length === 0 || userPath.includes("\0")) {
    return null;
  }
  const cleaned = userPath.trim().replace(/\\/g, "/");
  const segs: string[] = [];
  for (const part of cleaned.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    segs.push(part);
  }
  if (segs.length === 0) return null;
  return segs.join("/");
}
