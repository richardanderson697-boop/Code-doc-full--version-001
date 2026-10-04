// Uploaded-workspace file helpers: strict path containment and the
// recursive source-file scanner shared by the upload and audit routes.
import path from "path";
import fs from "fs";
import { log } from "./logger";

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

export function getWorkspaceFiles(dir: string, baseDir: string = dir): WorkspaceFile[] {
  let results: WorkspaceFile[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      const relativePath = path.relative(baseDir, filePath).replace(/\\/g, "/");

      // Skip ignored paths
      if (
        relativePath.startsWith("node_modules") ||
        relativePath.startsWith(".git") ||
        relativePath.startsWith("dist") ||
        relativePath.startsWith("data") ||
        relativePath.startsWith("assets") ||
        relativePath.includes("bun.lock") ||
        relativePath.includes("package-lock.json") ||
        relativePath.includes("yarn.lock")
      ) {
        continue;
      }

      if (stat && stat.isDirectory()) {
        results = results.concat(getWorkspaceFiles(filePath, baseDir));
      } else {
        const ext = path.extname(file).toLowerCase();
        // Only read source code, scripts, configuration, and documentation
        if ([".ts", ".tsx", ".json", ".js", ".jsx", ".css", ".html", ".md"].includes(ext)) {
          try {
            const content = fs.readFileSync(filePath, "utf8");
            const lineCount = countLines(content);
            results.push({
              path: relativePath,
              content,
              lineCount
            });
          } catch (e) {
            log.error(`Failed to read file ${relativePath}:`, e);
          }
        }
      }
    }
  } catch (err) {
    log.error("Directory scanning error:", err);
  }
  return results;
}

