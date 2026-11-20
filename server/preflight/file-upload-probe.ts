// First-party probe: file-upload validation (finalread-gap-detectors-spec.md Item 5).
//
// An upload handler that accepts files without validation, or stores
// uploaded files where they can be executed or served. An upload handler
// is a route/handler that uses an upload library (multer, formidable,
// busboy, express-fileupload, multiparty), accesses req.file / req.files,
// or reads formData(). It is a finding when NONE of these validations is
// present (in the handler file or in a validation helper applied to the
// route, checked over the full file set): a file-type check, a size
// limit, or a content check. If ANY validation is present, there is no
// finding — the probe flags the *absence* of validation, not the strength
// of an allowlist.
//
// The storage destination is recorded in the evidence: files stored in a
// publicly-served / web-root directory aggravate the finding; storage
// outside the web root leaves the finding on the missing validation
// alone. A filename used directly as a storage path (path traversal via
// filename) is NOT this detector — that is the Path Traversal probe's
// domain.
//
// Precision only (Richard, standing): validation in another file is
// checked via the corpus (a shared validateUpload middleware imported
// from another module counts); a validation idiom the probe does not
// recognise, or a helper it cannot resolve, routes to "Needs developer
// verification" (unverified: true + the specific question in
// remediation); validation present but files stored in the web root also
// routes to verification. The vendored engine is untouched.
import {
  collectRoutes,
  resolveRouteHandler,
  stripComments,
  callArgsText,
  resolveRelativeImport,
  importSpecForName,
  type CollectedRoute,
  type RouteHandlerInfo,
} from "./ast-util";
import { isTestFile } from "./vendor/lib/file-filter.js";
import type { PreFlightFinding } from "../../shared/preflight-types";
import type { ScanInputFile } from "../preflight-scan";

export const FILE_UPLOAD_PROBE = "File Upload Validation";

export const FILE_UPLOAD_QUESTION =
  "Does this upload handler validate file type, size, and content before storing the file? Point at the validation code that settles it.";

export const FILE_UPLOAD_WEBROOT_QUESTION =
  "The allowed file types are stored under the web root — can an uploaded file be served as a page or executed? Point at the storage config and the allowlist that settle it.";

// Recognised validation idioms (spec allowlist).
const UPLOAD_VALIDATION_RES: RegExp[] = [
  /fileFilter/i,
  /mimetype/i,
  /allowedTypes/i,
  /allowedExtensions/i,
  /extname/i,
  /fileTypeFromBuffer/i,
  /file-type/i,
  /fromBuffer/i,
  /limits\s*:\s*\{[^}]*fileSize/i,
  /maxSize/i,
  /fileSize/i,
  /magic/i,
  /antivirus/i,
  /clamav/i,
  /file\.size\s*>/i,
  /\.size\s*>\s*\d/i,
];

// A validation-like identifier the probe does not recognise (a custom
// isAllowedType helper, an unfamiliar file-type call). Present but
// unrecognised means the probe cannot establish whether validation
// exists — verification, not a liability.
const VALIDATION_LIKE_RE = /validat|file[\s_-]?type|magic|antivirus|clamav|mimetype|allowed[\s_-]?type|check[\s_-]?file|file[\s_-]?check|verify[\s_-]?file|file[\s_-]?verif|sanitiz/i;

// Upload-library / upload-signal idioms.
const UPLOAD_LIBRARY_RE =
  /\bmulter\s*\(|formidable\s*\(|busboy\s*\(|express-fileupload|multiparty|upload\.(?:single|array|fields|any)\s*\(/i;
const REQ_FILE_RE = /\breq\.files?\b/i;
const FORM_DATA_RE = /\b(?:req|request)\.formData\s*\(|formData\s*\(/i;

// A file is actually stored (formData alone is not enough — reading form
// fields without storing a file is not a finding).
const STORAGE_CALL_RE =
  /writeFile|createWriteStream|putObject|\.upload\s*\(|\.mv\s*\(|\.save\s*\(|storeFile|saveToDisk/i;

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hasValidation(text: string): boolean {
  if (!text) return false;
  const masked = stripComments(text);
  return UPLOAD_VALIDATION_RES.some((re) => re.test(masked));
}

function hasValidationLikeUnknown(text: string): boolean {
  if (!text) return false;
  const masked = stripComments(text);
  const ids = masked.match(/[A-Za-z_$][\w$]*/g) || [];
  for (const id of ids) {
    if (!VALIDATION_LIKE_RE.test(id)) continue;
    if (UPLOAD_VALIDATION_RES.some((re) => re.test(id))) continue;
    return true;
  }
  return false;
}

// The multer dest/destination string in a config text, or null.
function multerDest(configText: string): string | null {
  const masked = stripComments(configText);
  let m = masked.match(/\bdest\s*:\s*['"]([^'"]+)['"]/);
  if (m) return m[1];
  m = masked.match(/\bdestination\s*:\s*['"]([^'"]+)['"]/);
  if (m) return m[1];
  // destination: (req, file, cb) => cb(null, 'public/uploads/')
  m = masked.match(
    /\bdestination\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*[a-zA-Z_$][\w$]*\s*\(\s*null\s*,\s*['"]([^'"]+)['"]/
  );
  if (m) return m[1];
  return null;
}

// Directories served statically (express.static('X')) across the corpus.
function servedDirs(fileMap: Map<string, string>): string[] {
  const dirs: string[] = [];
  for (const [path, content] of fileMap) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    const masked = stripComments(content);
    for (const m of masked.matchAll(/express\.static\s*\(\s*['"]([^'"]+)['"]/g)) {
      dirs.push(m[1].replace(/^\.\//, "").replace(/\/$/, ""));
    }
  }
  return dirs;
}

function normDir(d: string): string {
  return d.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

// Is this storage destination under the web root (public/, static/, or a
// directory the server serves statically)?
function isWebRootDir(dest: string, dirs: string[]): boolean {
  const n = normDir(dest);
  if (/^(public|static)(\/|$)/.test(n)) return true;
  for (const d of dirs) {
    const sd = normDir(d);
    if (!sd) continue;
    if (n === sd || n.startsWith(sd + "/")) return true;
  }
  return false;
}

// The multer config text for a route: the multer(...) call in the route
// file, or in a file the route file imports the upload middleware from.
function multerConfigText(
  route: CollectedRoute,
  routeContent: string,
  fileMap: Map<string, string>,
  knownPaths: Set<string>
): string | null {
  const masked = stripComments(routeContent);
  const m = /\bmulter\s*\(/.exec(masked);
  if (m) {
    const openIdx = masked.indexOf("(", m.index);
    if (openIdx !== -1) {
      const args = callArgsText(masked, openIdx);
      if (args !== null) return args;
    }
  }
  // The upload middleware is imported from another file (e.g. `import
  // upload from './upload'`).
  for (const mw of route.middlewares) {
    const base = mw.split(".")[0];
    const spec = importSpecForName(routeContent, base);
    if (!spec) continue;
    const resolved = resolveRelativeImport(route.file, spec, knownPaths);
    if (!resolved) continue;
    const target = fileMap.get(resolved);
    if (target === undefined) continue;
    const tm = stripComments(target);
    const mm = /\bmulter\s*\(/.exec(tm);
    if (!mm) continue;
    const openIdx = tm.indexOf("(", mm.index);
    if (openIdx === -1) continue;
    const args = callArgsText(tm, openIdx);
    if (args !== null) return args;
  }
  return null;
}

export function probeFileUploadValidation(files: ScanInputFile[]): PreFlightFinding[] {
  try {
    return probeFileUploadInner(files);
  } catch {
    // Never-throw contract: a probe failure is recorded by the caller.
    return [];
  }
}

function probeFileUploadInner(files: ScanInputFile[]): PreFlightFinding[] {
  const findings: PreFlightFinding[] = [];
  const fileMap = new Map<string, string>();
  const knownPaths = new Set<string>();
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
    if (isTestFile(f.path)) continue;
    fileMap.set(f.path, f.content);
    knownPaths.add(f.path);
  }
  if (fileMap.size === 0) return findings;
  const dirs = servedDirs(fileMap);

  for (const [path, content] of fileMap) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    if (!UPLOAD_LIBRARY_RE.test(content) && !REQ_FILE_RE.test(content) && !FORM_DATA_RE.test(content)) {
      continue;
    }
    const routes = collectRoutes(content, path);
    for (const route of routes) {
      const method = route.method.toUpperCase();
      if (!MUTATION_METHODS.has(method)) continue;
      const handler = resolveRouteHandler(route, fileMap, knownPaths);
      const handlerText = handler.bodyText ?? "";
      const mwText = route.middlewares.join(" ");
      const routeText = [mwText, handlerText].join("\n");

      // Is this route an upload handler?
      const usesUploadLib = UPLOAD_LIBRARY_RE.test(routeText) || UPLOAD_LIBRARY_RE.test(content);
      const touchesReqFile = REQ_FILE_RE.test(handlerText);
      const readsFormData = FORM_DATA_RE.test(handlerText);
      const storesFile = STORAGE_CALL_RE.test(handlerText) || usesUploadLib || touchesReqFile;
      // formData alone (reading fields, never storing a file) is not a finding.
      if (!usesUploadLib && !touchesReqFile && !(readsFormData && storesFile)) continue;

      // Validation context: the route file, the handler body, and the
      // multer config (same file or a resolved import).
      const configText = multerConfigText(route, content, fileMap, knownPaths);
      const contextText = [content, handlerText, configText ?? ""].join("\n");
      const validated = hasValidation(contextText);

      // Storage destination (from the multer config, if any).
      const dest = configText ? multerDest(configText) : null;
      const webRoot = dest !== null && isWebRootDir(dest, dirs);

      // Unknown? A validation-like helper the probe cannot resolve, or
      // a handler it cannot inspect.
      let unknown = false;
      if (!route.parsed || !handler.resolved) unknown = true;
      if (!unknown && hasValidationLikeUnknown(routeText)) unknown = true;
      if (!unknown) {
        // An import of a validation-like name from a file not in the set.
        const masked = stripComments(content);
        for (const m of masked.matchAll(
          /import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g
        )) {
          const spec = m[1];
          if (!spec.startsWith(".")) continue;
          const importLine = masked.slice(Math.max(0, m.index - 200), m.index + m[0].length);
          if (!VALIDATION_LIKE_RE.test(importLine)) continue;
          if (!resolveRelativeImport(path, spec, knownPaths)) {
            unknown = true;
            break;
          }
        }
      }

      const label = route.path ? `${method} ${route.path}` : `${method} handler`;
      const storageNote =
        dest !== null
          ? webRoot
            ? `files stored under ${dest} (served statically)`
            : `files stored under ${dest}`
          : "storage destination not determinable";
      if (validated && webRoot) {
        // Validation is present but files are stored in the web root —
        // the probe cannot establish the allowed type is safe.
        findings.push({
          severity: "high",
          probe: FILE_UPLOAD_PROBE,
          title: `${label} stores uploads under the web root`,
          file: route.file,
          line: route.line,
          evidence: `${label} at ${route.file}:${route.line} — upload validation is present, but ${storageNote}.`,
          remediation: FILE_UPLOAD_WEBROOT_QUESTION,
          unverified: true,
          owasp: ["A08"],
          cwe: "CWE-434",
        });
        continue;
      }
      if (validated) continue; // any validation present → no finding
      if (unknown) {
        findings.push({
          severity: "high",
          probe: FILE_UPLOAD_PROBE,
          title: `${label} has no file-upload validation`,
          file: route.file,
          line: route.line,
          evidence: `${label} at ${route.file}:${route.line} — no file-type, size, or content validation found in the scanned files; the probe cannot establish whether validation lives in an unresolvable helper. ${storageNote}.`,
          remediation: FILE_UPLOAD_QUESTION,
          unverified: true,
          owasp: ["A08"],
          cwe: "CWE-434",
        });
        continue;
      }
      findings.push({
        severity: "high",
        probe: FILE_UPLOAD_PROBE,
        title: `${label} has no file-upload validation`,
        file: route.file,
        line: route.line,
        evidence: `${label} at ${route.file}:${route.line} — no fileFilter, mimetype allowlist, size limit, or content check found in the scanned files; ${storageNote}.`,
        remediation:
          "Validate uploads before storing them: restrict file types with a fileFilter or mimetype/extension allowlist, enforce a size limit (limits.fileSize), and sniff content or scan for malware where the file type matters. Store uploads outside the web root (or serve them through a controller, never as static files).",
        owasp: ["A08"],
        cwe: "CWE-434",
      });
    }
  }
  return findings;
}
