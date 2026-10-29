// Uploaded-codebase workspace routes: ZIP intake, file CRUD, AI file generation.
//
// Workspace files live in Postgres (workspace_files table), not on disk:
// the old on-disk uploaded_project/<userId>/ directories were wiped by every
// Railway redeploy. All paths are validated with cleanWorkspacePath; tenant
// isolation comes from the user_id column on every query.
import { Router } from "express";
import { asyncRoute } from "../async-route";
import AdmZip from "adm-zip";
import { formatGeminiError, generateWithFallback, extractUsage } from "../gemini";
import {
  cleanWorkspacePath,
  isIgnorableWorkspacePath,
  isWorkspaceFileExt,
  countLines,
} from "../workspace";
import {
  listWorkspaceFiles,
  getWorkspaceFile,
  saveWorkspaceFile,
  deleteWorkspaceFile,
  clearWorkspaceFiles,
  replaceWorkspaceFiles,
  type WorkspaceSource,
} from "../workspace-store";
import { readZipHeader, hasUnsafeEntryName } from "../zip-guard";
import {
  parseGitHubRepoUrl,
  isValidRef,
  buildArchiveUrl,
  isAllowedFetchHost,
} from "../repo-import";
import { log } from "../logger";
import { requireAuth, requireCredits, AuthedRequest } from "../middleware/requireAuth";
import { chargeForCall } from "../credits";

const router = Router();

// Archive limits. MAX_ARCHIVE_BYTES bounds the raw upload; the entry cap
// bounds how much a ZIP library will allocate from it.
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

const EMPTY_WORKSPACE_ERROR = "Workspace is empty \u2014 nothing to download.";

// Shared ZIP ingestion: validates a ZIP buffer and atomically replaces the
// user's workspace files. Used by manual uploads and repo-URL imports.
// Throws { status, message } on validation failure so routes can map it.
// The origin rides with the replace: pass the new source, or nothing when
// unknown, so a stale source can never describe replaced content.
export async function ingestZipBuffer(
  userId: string,
  buffer: Buffer,
  opts: { stripTopLevelDir?: boolean; source?: WorkspaceSource | null } = {}
): Promise<{ fileCount: number }> {
  const fail = (status: number, message: string): never => {
    throw { status, message };
  };
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    fail(
      400,
      `ZIP archive is ${Math.round(buffer.length / 1024 / 1024)}MB (limit ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB).`
    );
  }

  // Entry count comes from the archive's own directory record. Reading it
  // here is O(1); asking a ZIP library for the entries allocates ~8.7KB of
  // heap each, so the limit has to be checked before that call, not after.
  const header = readZipHeader(buffer);
  if (!header) {
    fail(400, "File is not a valid ZIP archive.");
  }
  if (header.entryCount > MAX_ZIP_ENTRIES) {
    fail(
      400,
      `ZIP declares ${header.entryCount} entries (limit ${MAX_ZIP_ENTRIES}). Please upload a smaller codebase.`
    );
  }

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  // The declared count is attacker-controlled; re-check the real one.
  if (entries.length > MAX_ZIP_ENTRIES) {
    fail(
      400,
      `ZIP contains ${entries.length} entries (limit ${MAX_ZIP_ENTRIES}). Please upload a smaller codebase.`
    );
  }
  let totalUncompressed = 0;
  for (const entry of entries) {
    if (hasUnsafeEntryName(entry.entryName)) {
      fail(400, "ZIP contains unsafe file paths and was rejected.");
    }
    totalUncompressed += entry.header.size;
  }
  if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
    fail(400, "ZIP expands beyond the 200MB limit and was rejected.");
  }

  // GitHub archive zips wrap everything in a single "<repo>-<branch>/" dir.
  // Strip it so finding paths stay clean — only when EVERY file entry shares
  // the same single top-level segment.
  let prefix = "";
  if (opts.stripTopLevelDir) {
    const tops = new Set<string>();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const first = entry.entryName.split("/")[0];
      if (first) tops.add(first);
    }
    if (tops.size === 1) prefix = [...tops][0] + "/";
  }

  // Validation passed: only now replace the existing workspace, atomically.
  const ingest: { path: string; content: string }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    let name = entry.entryName;
    if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length);
    const relPath = cleanWorkspacePath(name);
    if (!relPath || isIgnorableWorkspacePath(relPath) || !isWorkspaceFileExt(relPath)) continue;
    ingest.push({ path: relPath, content: entry.getData().toString("utf8") });
  }
  await replaceWorkspaceFiles(userId, ingest, opts.source ?? null);
  return { fileCount: ingest.length };
}

// ZIP Codebase Upload, Status, and Clear Endpoints
router.post("/api/upload-zip", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const { zipBase64, fileName } = req.body;
  if (typeof zipBase64 !== "string" || !zipBase64) {
    return res.status(400).json({ error: "No ZIP file data provided." });
  }

  try {
    const userId = req.user!.id;

    // Reject on the encoded length, before decoding. Checking buffer.length
    // afterwards still performed the ~75MB allocation it was meant to prevent.
    // base64 is 4 characters per 3 bytes.
    const declaredBytes = Math.floor((zipBase64.length * 3) / 4);
    if (declaredBytes > MAX_ARCHIVE_BYTES) {
      return res.status(400).json({
        error: `ZIP archive is ${Math.round(declaredBytes / 1024 / 1024)}MB (limit ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB).`
      });
    }
    const buffer = Buffer.from(zipBase64, "base64");
    // Record the upload filename when the client sends it; otherwise the
    // replace clears any stale source (see ingestZipBuffer).
    const zipSource: WorkspaceSource | null =
      typeof fileName === "string" && fileName.trim()
        ? { kind: "zip", filename: fileName.trim() }
        : null;
    await ingestZipBuffer(userId, buffer, { source: zipSource });

    const files = await listWorkspaceFiles(userId);
    res.json({
      success: true,
      message: `Extracted ${files.length} files successfully.`,
      files: files.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    if (error?.status) {
      return res.status(error.status).json({ error: error.message });
    }
    log.error("ZIP Extraction Error:", error);
    res.status(500).json({ error: "Failed to extract ZIP file. Check that the archive is a valid ZIP." });
  }
}));

// GitHub repo import: paste-a-URL onboarding. Fetches the repo's ZIP archive
// server-side and ingests it through the same validated pipeline as manual
// uploads. Public repos only in v1.
const REPO_FETCH_TIMEOUT_MS = 60000;
const REPO_FETCH_MAX_REDIRECTS = 5;

async function fetchRepoArchive(owner: string, repo: string, branch: string): Promise<Buffer> {
  // The URL is built from validated components only — never from raw user
  // input (see server/repo-import.ts).
  let current = buildArchiveUrl(owner, repo, branch);
  for (let hops = 0; hops < REPO_FETCH_MAX_REDIRECTS; hops++) {
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(REPO_FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "GradeVibes-repo-import" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw { status: 502, message: "GitHub returned a redirect with no location." };
      const next = new URL(loc, current);
      if (next.protocol !== "https:" || !isAllowedFetchHost(next.hostname)) {
        throw { status: 502, message: "GitHub redirected to an unexpected host; fetch aborted." };
      }
      current = next.toString();
      continue;
    }
    if (res.status === 404) throw { status: 404, message: `Branch "${branch}" not found.` };
    if (!res.ok || !res.body) throw { status: 502, message: `GitHub fetch failed (HTTP ${res.status}).` };
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
      throw {
        status: 400,
        message: `Repository archive is larger than the ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB limit.`
      };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ARCHIVE_BYTES) {
          await reader.cancel();
          throw {
            status: 400,
            message: `Repository archive exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB limit.`
          };
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  throw { status: 502, message: "Too many redirects fetching the repository." };
}

router.post("/api/import-repo", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const parsed = parseGitHubRepoUrl(req.body?.repoUrl);
  if (!parsed) {
    return res.status(400).json({
      error: "Please paste a valid GitHub repository URL, e.g. https://github.com/owner/repo."
    });
  }
  const ref = req.body?.ref;
  if (ref !== undefined && !isValidRef(ref)) {
    return res.status(400).json({ error: "Invalid branch name." });
  }
  const branches = ref ? [ref] : ["main", "master"];
  let buffer: Buffer | null = null;
  for (const branch of branches) {
    try {
      buffer = await fetchRepoArchive(parsed.owner, parsed.repo, branch);
      break;
    } catch (err: any) {
      if (err?.status === 404) continue; // try the next candidate branch
      if (err?.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }
  if (!buffer) {
    return res.status(404).json({
      error: `Could not fetch the repository (tried branches ${branches.join(", ")}). Check the URL and that the repo is public.`
    });
  }
  try {
    await ingestZipBuffer(userId, buffer, {
      stripTopLevelDir: true,
      source: {
        kind: "github",
        owner: parsed.owner,
        repo: parsed.repo,
        url: `https://github.com/${parsed.owner}/${parsed.repo}`,
      },
    });
    const files = await listWorkspaceFiles(userId);
    res.json({
      success: true,
      message: `Imported ${files.length} files from github.com/${parsed.owner}/${parsed.repo}.`,
      files: files.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    if (error?.status) {
      return res.status(error.status).json({ error: error.message });
    }
    log.error("Repo Import Error:", error);
    res.status(500).json({ error: "Failed to import the repository." });
  }
}));

router.post("/api/clear-upload", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  try {
    await clearWorkspaceFiles(req.user!.id);
    res.json({ success: true, message: "Uploaded codebase cleared successfully." });
  } catch (error: any) {
    log.error("Clear Upload Error:", error);
    res.status(500).json({ error: "Failed to clear uploaded codebase" });
  }
}));

// Download the user's workspace as a ZIP archive. Streams the archive;
// nothing is written to disk and the workspace is untouched.
router.get("/api/download-workspace", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  try {
    const files = await listWorkspaceFiles(req.user!.id);
    if (files.length === 0) {
      return res.status(404).json({ error: EMPTY_WORKSPACE_ERROR });
    }
    const zip = new AdmZip();
    for (const f of files) {
      zip.addFile(f.path, Buffer.from(f.content, "utf8"));
    }
    const buf = zip.toBuffer();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="gradevibes-project.zip"');
    res.setHeader("Content-Length", String(buf.length));
    res.send(buf);
  } catch (error: any) {
    log.error("Workspace Download Error:", error);
    res.status(500).json({ error: "Failed to build workspace ZIP" });
  }
}));

router.get("/api/upload-status", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  try {
    const files = await listWorkspaceFiles(req.user!.id);
    return res.json({
      uploaded: files.length > 0,
      files: files.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    log.error("Upload Status Error:", error);
    res.json({ uploaded: false, files: [] });
  }
}));

router.get("/api/uploaded-file", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      return res.status(400).json({ error: "Missing path parameter" });
    }
    const relPath = cleanWorkspacePath(filePath);
    if (!relPath) {
      return res.status(403).json({ error: "Access denied" });
    }
    const row = await getWorkspaceFile(req.user!.id, relPath);
    if (!row) {
      return res.status(404).json({ error: "File not found" });
    }
    return res.json({ content: row.content });
  } catch (error: any) {
    log.error("Uploaded File Error:", error);
    res.status(500).json({ error: "Failed to retrieve file content" });
  }
}));

// Save custom file directly into the uploaded workspace
router.post("/api/save-workspace-file", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  try {
    const { filePath, content } = req.body;
    if (!filePath || typeof content !== "string") {
      return res.status(400).json({ error: "filePath and content string are required" });
    }
    const relPath = cleanWorkspacePath(filePath);
    if (!relPath) {
      return res.status(403).json({ error: "Access denied" });
    }

    await saveWorkspaceFile(req.user!.id, relPath, content);

    const scannedFiles = await listWorkspaceFiles(req.user!.id);
    res.json({
      success: true,
      message: `File "${relPath}" saved to workspace ledger successfully.`,
      filePath: relPath,
      lineCount: countLines(content),
      files: scannedFiles.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    log.error("Save Workspace File Error:", error);
    res.status(500).json({ error: "Failed to save file to workspace" });
  }
}));

// Delete a custom file from the uploaded workspace
router.post("/api/delete-workspace-file", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: "filePath is required" });
    }
    const relPath = cleanWorkspacePath(filePath);
    if (!relPath) {
      return res.status(403).json({ error: "Access denied" });
    }

    await deleteWorkspaceFile(req.user!.id, relPath);

    const scannedFiles = await listWorkspaceFiles(req.user!.id);
    res.json({
      success: true,
      message: `File "${relPath}" removed from workspace.`,
      files: scannedFiles.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    log.error("Delete Workspace File Error:", error);
    res.status(500).json({ error: "Failed to delete file from workspace" });
  }
}));

// AI Generate individual workspace file across multiple prompts
router.post("/api/generate-workspace-file", requireAuth, requireCredits("workspaceFile"), asyncRoute(async (req: AuthedRequest, res) => {
  const { filePath, prompt, systemInstruction: customInstruction, existingCode } = req.body;
  if (!filePath || !prompt) {
    return res.status(400).json({ error: "filePath and prompt are required" });
  }

  try {
    const userId = req.user!.id;

    // Validate the target path before it is used anywhere (prompt or store).
    const safePath = cleanWorkspacePath(filePath);
    if (!safePath) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Context: the path list PLUS truncated contents of existing files
    // (excluding the target), so imports/exports across files actually line
    // up. Budget-capped to bound input tokens per file.
    const existingFiles = await listWorkspaceFiles(userId);
    const CONTEXT_BUDGET = 30000;
    const contextParts: string[] = [];
    let contextUsed = 0;
    for (const f of existingFiles) {
      if (f.path === safePath) continue;
      const snippet = f.content.slice(0, 2000);
      if (contextUsed + snippet.length > CONTEXT_BUDGET) break;
      contextUsed += snippet.length;
      contextParts.push(`--- ${f.path} ---\n${snippet}`);
    }
    const contextBlock = contextParts.length > 0
      ? contextParts.join("\n\n")
      : "(None yet - this is the first file)";

    const isRefinement = typeof existingCode === "string" && existingCode.trim().length > 0;
    const createInstruction = `You are VibeCoder, a master AI software architect. You are generating a specific project file named "${safePath}" as part of an accumulated multi-file workspace application.

Existing Workspace Files (truncated contents for cross-file consistency):
${contextBlock}

Task: Generate the complete, production-ready code content for "${safePath}" based on the user's prompt. Import from sibling files with relative paths ONLY, and only import names that are actually exported by those files (see contents above). Ensure all exports, imports, and functions match standard modern TypeScript/JavaScript patterns.`;
    const refineInstruction = `You are VibeCoder, a master AI software architect. You are REFINING a specific project file named "${safePath}" as part of an accumulated multi-file workspace application.

Existing Workspace Files (truncated contents for cross-file consistency):
${contextBlock}

=== CURRENT CONTENT OF "${safePath}" ===
${existingCode}
=== END CURRENT CONTENT ===

Task: EDIT the current content according to the user's prompt. Preserve all working logic, exports, and import paths unless the prompt asks to change them. Keep every import specifier relative and pointing at files that exist in the workspace above.`;
    // Shared response-format contract for both create and refine paths.
    const formatBlock = `

You MUST format your response EXACTLY as follows:

====CODE====
[Provide 100% executable raw file content for ${safePath}. Do not use markdown wrappers like \`\`\` inside this section]

====PURPOSE====
[Provide a concise 2-4 sentence explanation of what this specific file does, key exported functions/types, and its architectural role in the overall application]`;
    const fileGenSystemInstruction = (customInstruction || (isRefinement ? refineInstruction : createInstruction)) + (customInstruction ? "" : formatBlock);

    const { response: genResponse, modelName } = await generateWithFallback({
      contents: `File to create: ${safePath}\nPrompt instructions: ${prompt}`,
      config: {
        systemInstruction: fileGenSystemInstruction,
        temperature: 0.7
      }
    });
    const workspaceFileBalance = await chargeForCall(req.user!.id, extractUsage(genResponse), modelName, "workspace file generation");
    if (workspaceFileBalance != null) res.set("X-Credits-Balance", String(workspaceFileBalance));

    const responseText = genResponse.text || "";
    let code = "";
    let purpose = "";

    const codeIdx = responseText.indexOf("====CODE====");
    const purposeIdx = responseText.indexOf("====PURPOSE====");

    if (codeIdx !== -1 && purposeIdx !== -1) {
      if (codeIdx < purposeIdx) {
        purpose = responseText.substring(purposeIdx + 15).trim();
        code = responseText.substring(codeIdx + 12, purposeIdx).trim();
      } else {
        purpose = responseText.substring(purposeIdx + 15, codeIdx).trim();
        code = responseText.substring(codeIdx + 12).trim();
      }
    } else if (codeIdx !== -1) {
      code = responseText.substring(codeIdx + 12).trim();
    } else {
      code = responseText.trim();
    }

    // Save to the store (safePath was validated before generation)
    await saveWorkspaceFile(userId, safePath, code);

    const scannedFiles = await listWorkspaceFiles(userId);
    res.json({
      success: true,
      filePath: safePath,
      content: code,
      purpose: purpose || "Custom generated project file.",
      lineCount: countLines(code),
      files: scannedFiles.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    log.error("Generate Workspace File Error:", error);
    res.status(500).json({ error: formatGeminiError(error) });
  }
}));

export default router;
