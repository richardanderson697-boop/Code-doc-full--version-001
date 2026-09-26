// Uploaded-codebase workspace routes: ZIP intake, file CRUD, AI file generation.
import { Router } from "express";
import { asyncRoute } from "../async-route";
import path from "path";
import fs from "fs";
import AdmZip from "adm-zip";
import { formatGeminiError, generateWithFallback, extractUsage } from "../gemini";
import { resolveInsideDir, getWorkspaceFiles, uploadedDir as uploadedDirPath } from "../workspace";
import { readZipHeader, hasUnsafeEntryName } from "../zip-guard";
import { log } from "../logger";
import { requireAuth, requireCredits, AuthedRequest } from "../middleware/requireAuth";
import { chargeForCall } from "../credits";

const router = Router();

// Archive limits. MAX_ARCHIVE_BYTES bounds the raw upload; the entry cap
// bounds how much a ZIP library will allocate from it.
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

// ZIP Codebase Upload, Status, and Clear Endpoints
router.post("/api/upload-zip", requireAuth, asyncRoute(async (req: AuthedRequest, res) => {
  const { zipBase64 } = req.body;
  if (!zipBase64) {
    return res.status(400).json({ error: "No ZIP file data provided." });
  }

  try {
    const uploadedDir = uploadedDirPath(req.user!.id);

    // Validate the archive completely before touching the existing workspace:
    // a malformed upload used to delete the user's files and then fail.
    if (typeof zipBase64 !== "string") {
      return res.status(400).json({ error: "No ZIP file data provided." });
    }

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
    if (buffer.length > MAX_ARCHIVE_BYTES) {
      return res.status(400).json({
        error: `ZIP archive is ${Math.round(buffer.length / 1024 / 1024)}MB (limit ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB).`
      });
    }

    // Entry count comes from the archive's own directory record. Reading it
    // here is O(1); asking a ZIP library for the entries allocates ~8.7KB of
    // heap each, so the limit has to be checked before that call, not after.
    const header = readZipHeader(buffer);
    if (!header) {
      return res.status(400).json({ error: "File is not a valid ZIP archive." });
    }
    if (header.entryCount > MAX_ZIP_ENTRIES) {
      return res.status(400).json({
        error: `ZIP declares ${header.entryCount} entries (limit ${MAX_ZIP_ENTRIES}). Please upload a smaller codebase.`
      });
    }

    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    // The declared count is attacker-controlled; re-check the real one.
    if (entries.length > MAX_ZIP_ENTRIES) {
      return res.status(400).json({
        error: `ZIP contains ${entries.length} entries (limit ${MAX_ZIP_ENTRIES}). Please upload a smaller codebase.`
      });
    }
    let totalUncompressed = 0;
    for (const entry of entries) {
      if (hasUnsafeEntryName(entry.entryName)) {
        return res.status(400).json({ error: "ZIP contains unsafe file paths and was rejected." });
      }
      totalUncompressed += entry.header.size;
    }
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      return res.status(400).json({
        error: "ZIP expands beyond the 200MB limit and was rejected."
      });
    }

    // Validation passed: only now replace the existing workspace.
    if (fs.existsSync(uploadedDir)) {
      fs.rmSync(uploadedDir, { recursive: true, force: true });
    }
    fs.mkdirSync(uploadedDir, { recursive: true });
    zip.extractAllTo(uploadedDir, true);

    // Scan the unzipped files
    const files = getWorkspaceFiles(uploadedDir, uploadedDir);

    res.json({
      success: true,
      message: `Extracted ${files.length} files successfully.`,
      files: files.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    log.error("ZIP Extraction Error:", error);
    res.status(500).json({ error: "Failed to extract ZIP file. Check that the archive is a valid ZIP." });
  }
}));

router.post("/api/clear-upload", requireAuth, (req: AuthedRequest, res) => {
  try {
    const uploadedDir = uploadedDirPath(req.user!.id);
    if (fs.existsSync(uploadedDir)) {
      fs.rmSync(uploadedDir, { recursive: true, force: true });
    }
    res.json({ success: true, message: "Uploaded codebase cleared successfully." });
  } catch (error: any) {
    log.error("Clear Upload Error:", error);
    res.status(500).json({ error: "Failed to clear uploaded codebase" });
  }
});

router.get("/api/upload-status", requireAuth, (req: AuthedRequest, res) => {
  try {
    const uploadedDir = uploadedDirPath(req.user!.id);
    if (fs.existsSync(uploadedDir)) {
      const files = getWorkspaceFiles(uploadedDir, uploadedDir);
      return res.json({
        uploaded: files.length > 0,
        files: files.map(f => ({ path: f.path, lineCount: f.lineCount }))
      });
    }
    res.json({ uploaded: false, files: [] });
  } catch (error: any) {
    res.json({ uploaded: false, files: [] });
  }
});

router.get("/api/uploaded-file", requireAuth, (req: AuthedRequest, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      return res.status(400).json({ error: "Missing path parameter" });
    }
    const uploadedDir = uploadedDirPath(req.user!.id);
    const fullPath = resolveInsideDir(uploadedDir, filePath);
    if (!fullPath) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf8");
      return res.json({ content });
    } else {
      return res.status(404).json({ error: "File not found" });
    }
  } catch (error: any) {
    log.error("Uploaded File Error:", error);
    res.status(500).json({ error: "Failed to retrieve file content" });
  }
});

// Save custom file directly into the uploaded workspace
router.post("/api/save-workspace-file", requireAuth, (req: AuthedRequest, res) => {
  try {
    const { filePath, content } = req.body;
    if (!filePath || typeof content !== "string") {
      return res.status(400).json({ error: "filePath and content string are required" });
    }
    const uploadedDir = uploadedDirPath(req.user!.id);
    if (!fs.existsSync(uploadedDir)) {
      fs.mkdirSync(uploadedDir, { recursive: true });
    }

    const fullPath = resolveInsideDir(uploadedDir, filePath);
    if (!fullPath) {
      return res.status(403).json({ error: "Access denied" });
    }
    const safePath = path.relative(uploadedDir, fullPath).replace(/\\/g, "/");

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");

    const scannedFiles = getWorkspaceFiles(uploadedDir, uploadedDir);
    res.json({
      success: true,
      message: `File "${safePath}" saved to workspace ledger successfully.`,
      filePath: safePath,
      lineCount: content.split("\n").length,
      files: scannedFiles.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    log.error("Save Workspace File Error:", error);
    res.status(500).json({ error: "Failed to save file to workspace" });
  }
});

// Delete a custom file from the uploaded workspace
router.post("/api/delete-workspace-file", requireAuth, (req: AuthedRequest, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: "filePath is required" });
    }
    const uploadedDir = uploadedDirPath(req.user!.id);
    const fullPath = resolveInsideDir(uploadedDir, filePath);
    if (!fullPath) {
      return res.status(403).json({ error: "Access denied" });
    }
    const safePath = path.relative(uploadedDir, fullPath).replace(/\\/g, "/");

    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }

    const scannedFiles = fs.existsSync(uploadedDir) ? getWorkspaceFiles(uploadedDir, uploadedDir) : [];
    res.json({
      success: true,
      message: `File "${safePath}" removed from workspace.`,
      files: scannedFiles.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    log.error("Delete Workspace File Error:", error);
    res.status(500).json({ error: "Failed to delete file from workspace" });
  }
});

// AI Generate individual workspace file across multiple prompts
router.post("/api/generate-workspace-file", requireAuth, requireCredits("workspaceFile"), asyncRoute(async (req: AuthedRequest, res) => {
  const { filePath, prompt, systemInstruction: customInstruction } = req.body;
  if (!filePath || !prompt) {
    return res.status(400).json({ error: "filePath and prompt are required" });
  }

  try {
    const uploadedDir = uploadedDirPath(req.user!.id);
    if (!fs.existsSync(uploadedDir)) {
      fs.mkdirSync(uploadedDir, { recursive: true });
    }

    // Validate the target path before it is used anywhere (prompt or disk).
    const fullPath = resolveInsideDir(uploadedDir, filePath);
    if (!fullPath) {
      return res.status(403).json({ error: "Access denied" });
    }
    const safePath = path.relative(uploadedDir, fullPath).replace(/\\/g, "/");

    // Scan existing workspace files to give AI full context of accumulated files
    const existingFiles = getWorkspaceFiles(uploadedDir, uploadedDir);
    const existingFileList = existingFiles.map(f => f.path).join("\n- ");

    const fileGenSystemInstruction = customInstruction || `You are VibeCoder, a master AI software architect. You are generating a specific project file named "${safePath}" as part of an accumulated multi-file workspace application.

Existing Workspace Files accumulated so far:
- ${existingFileList || "(None yet - this is the first file)"}

Task: Generate the complete, production-ready code content for "${safePath}" based on the user's prompt. Ensure all exports, imports, and functions match standard modern TypeScript/JavaScript patterns.

You MUST format your response EXACTLY as follows:

====CODE====
[Provide 100% executable raw file content for ${safePath}. Do not use markdown wrappers like \`\`\` inside this section]

====PURPOSE====
[Provide a concise 2-4 sentence explanation of what this specific file does, key exported functions/types, and its architectural role in the overall application]`;

    const { response: genResponse, modelName } = await generateWithFallback({
      contents: `File to create: ${safePath}\nPrompt instructions: ${prompt}`,
      config: {
        systemInstruction: fileGenSystemInstruction,
        temperature: 0.7
      }
    });
    const workspaceFileBalance = chargeForCall(req.user!.id, extractUsage(genResponse), modelName, "workspace file generation");
    if (workspaceFileBalance != null) res.set("X-Credits-Balance", String(workspaceFileBalance));

    const responseText = genResponse.text || "";
    let code = "";
    let purpose = "";

    const codeIdx = responseText.indexOf("====CODE====");
    const purposeIdx = responseText.indexOf("====PURPOSE====");

    if (codeIdx !== -1 && purposeIdx !== -1) {
      if (codeIdx < purposeIdx) {
        code = responseText.substring(codeIdx + 12, purposeIdx).trim();
        purpose = responseText.substring(purposeIdx + 15).trim();
      } else {
        purpose = responseText.substring(purposeIdx + 15, codeIdx).trim();
        code = responseText.substring(codeIdx + 12).trim();
      }
    } else if (codeIdx !== -1) {
      code = responseText.substring(codeIdx + 12).trim();
    } else {
      code = responseText.trim();
    }

    // Save to disk (fullPath was containment-checked before generation)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, code, "utf8");

    const scannedFiles = getWorkspaceFiles(uploadedDir, uploadedDir);
    res.json({
      success: true,
      filePath: safePath,
      content: code,
      purpose: purpose || "Custom generated project file.",
      lineCount: code.split("\n").length,
      files: scannedFiles.map(f => ({ path: f.path, lineCount: f.lineCount }))
    });
  } catch (error: any) {
    log.error("Generate Workspace File Error:", error);
    res.status(500).json({ error: formatGeminiError(error) });
  }
}));

export default router;
