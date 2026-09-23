// Uploaded-workspace file helpers: strict path containment and the
// recursive source-file scanner shared by the upload and audit routes.
import path from "path";
import fs from "fs";
import { log } from "./logger";

export const UPLOADED_DIR_NAME = "uploaded_project";

// Resolved per call and overridable by CODEDOC_UPLOAD_DIR so tests never touch
// a real workspace. Every route uses this rather than rebuilding the path.
export function uploadedDir(): string {
  return process.env.CODEDOC_UPLOAD_DIR || path.join(process.cwd(), UPLOADED_DIR_NAME);
}

// 3.95. Workspace Project Intelligence Endpoint (Full Workspace Analyzer)

export interface WorkspaceFile {
  path: string;
  content: string;
  lineCount: number;
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
            const lineCount = content.split("\n").length;
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

