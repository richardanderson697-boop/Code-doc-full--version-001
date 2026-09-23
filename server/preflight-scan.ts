// Typed adapter over the vendored PreFlight engine (see preflight/VENDORED.md).
//
// The engine's per-probe try/catch protects the probe loop, but steps outside
// that loop (repo-config suppression parsing, scoring) are unguarded, and a
// malformed .preflight.json in scanned input can throw from scan() itself.
// This adapter is the containment boundary: runPreFlightScan NEVER throws.
// A scan failure degrades to an empty report carrying `failed`, so callers
// keep serving and the UI can say "not measured" instead of "clean".
import { scan, engineInfo } from "./preflight/vendor/lib/cockpit-scan.js";
import { log } from "./logger";
import { PreFlightFinding, PreFlightReport, SEVERITY_ORDER } from "../shared/preflight-types";

export type { PreFlightFinding, PreFlightReport };

export interface ScanInputFile {
  path: string;
  content: string;
}

// The engine is synchronous and superlinear in input length, so it runs on the
// request thread and a big enough file blocks every other request.
//
// Several probes carry regexes that backtrack quadratically, and the cost is
// driven by LINE length rather than file length: one long line is far worse
// than the same bytes split across many. Measured against a single line of
// filler, whole-scan time was ~4.8s at 128KB, ~20s at 256KB, ~85s at 512KB.
// So bound both, and bound the longest line hardest. Minified bundles trip the
// line guard, which is fine: they are generated output, not code worth
// auditing. Anything skipped is reported, never silently dropped.
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_LINE_CHARS = 20000;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_FILES = 1500;

// Bytes alone do not bound the work. Cost grows faster than linearly in file
// count, so ~16 individually-legal 256KB files inside the 4MB budget still
// blocked for ~66s. This is a wall-clock ceiling checked between files: the
// scan stops accepting new input once it is reached, and says how much it
// dropped. A deadline rather than a byte count, because time is the thing
// actually being protected.
export const MAX_SCAN_MS = 10000;

// Cross-file probes (architecture, package correlation) only see what is in a
// single scan() call, so batching costs analysis quality. Measured cost of one
// call: 2.7s for 256KB, 7.0s for 512KB, 15.0s for 1MB, 30.2s for 2MB. So scan
// everything in one pass while the total stays small, which covers ordinary
// projects, and only fall back to deadline-bounded batches above that.
//
// The deadline can only be checked between calls, so worst-case overshoot is
// one batch. Batches are kept to two files for that reason.
//
// The real fix is to move this off the request thread entirely (worker thread
// or a job queue). Until then these bounds are what keeps one upload from
// monopolising the server.
const SINGLE_PASS_BYTES = 384 * 1024;
const BATCH_SIZE = 2;

function longestLine(text: string): number {
  let longest = 0;
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      return Math.max(longest, text.length - start);
    }
    longest = Math.max(longest, nl - start);
    start = nl + 1;
  }
}

const SEVERITIES = new Set(SEVERITY_ORDER);

function emptyReport(overrides: Partial<PreFlightReport> = {}): PreFlightReport {
  return {
    engine: "PreFlight",
    probeCount: safeProbeCount(),
    filesScanned: 0,
    filesSkipped: [],
    score: 0,
    counts: {},
    findings: [],
    probeFailures: [],
    failed: null,
    ...overrides,
  };
}

function safeProbeCount(): number {
  try {
    return engineInfo().probeCount;
  } catch {
    return 0;
  }
}

// Select what actually goes to the engine, recording every exclusion.
function selectFiles(files: ScanInputFile[]) {
  const selected: ScanInputFile[] = [];
  const skipped: PreFlightReport["filesSkipped"] = [];
  let total = 0;

  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
      skipped.push({ path: String(f?.path ?? "(unknown)"), reason: "malformed entry" });
      continue;
    }
    if (selected.length >= MAX_FILES) {
      skipped.push({ path: f.path, reason: `file limit of ${MAX_FILES} reached` });
      continue;
    }
    const bytes = Buffer.byteLength(f.content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      skipped.push({
        path: f.path,
        reason: `file is ${Math.round(bytes / 1024)}KB, over the ${MAX_FILE_BYTES / 1024}KB per-file scan limit`,
      });
      continue;
    }
    const lineLen = longestLine(f.content);
    if (lineLen > MAX_LINE_CHARS) {
      skipped.push({
        path: f.path,
        reason: `longest line is ${lineLen} characters, over the ${MAX_LINE_CHARS} limit (minified or generated output)`,
      });
      continue;
    }
    if (total + bytes > MAX_TOTAL_BYTES) {
      skipped.push({
        path: f.path,
        reason: `total scan budget of ${MAX_TOTAL_BYTES / 1024 / 1024}MB reached`,
      });
      continue;
    }
    total += bytes;
    selected.push(f);
  }
  return { selected, skipped };
}

// The real engine never emits an unknown severity, a non-array OWASP mapping,
// or a probe failure on our corpus, so the code handling those cases is
// unreachable from a normal scan and its tests could not fail. This seam lets
// a test supply an engine that does emit them. Production passes nothing.
export interface ScanEngine {
  (files: ScanInputFile[]): any;
}

export function runPreFlightScan(
  files: ScanInputFile[],
  engine: ScanEngine = scan
): PreFlightReport {
  if (!Array.isArray(files)) {
    return emptyReport({ failed: "scan input was not an array of files" });
  }

  const { selected, skipped } = selectFiles(files);
  if (selected.length === 0) {
    return emptyReport({ filesSkipped: skipped });
  }

  // Scan in batches against a wall-clock deadline. The engine has no interrupt
  // and a single call over the whole set can block for a minute even inside the
  // byte caps, so bound the work by time and report what was dropped.
  const started = Date.now();
  let result: any;
  try {
    const totalBytes = selected.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
    if (totalBytes <= SINGLE_PASS_BYTES) {
      result = engine(selected);
    } else {
      result = { findings: [], probeFailures: [], score: 0 };
      let i = 0;
      for (; i < selected.length; i += BATCH_SIZE) {
        if (Date.now() - started > MAX_SCAN_MS) break;
        const part = engine(selected.slice(i, i + BATCH_SIZE));
        result.findings.push(...(part.findings || []));
        result.probeFailures.push(...(part.probeFailures || []));
        result.score = typeof part.score === "number" ? Math.min(result.score || 100, part.score) : result.score;
      }
      for (let j = i; j < selected.length; j++) {
        skipped.push({
          path: selected[j].path,
          reason: `scan time budget of ${MAX_SCAN_MS / 1000}s reached before this file`,
        });
      }
      if (i < selected.length) selected.length = i;
    }
  } catch (err: any) {
    // A malformed repo config in the scanned input reaches this. Degrade
    // rather than letting it escape into an async route handler, where an
    // unhandled rejection would take the process down.
    const message = err?.message || String(err);
    log.error("PreFlight scan failed:", err);
    return emptyReport({
      filesSkipped: skipped,
      failed: `Deterministic scan could not complete: ${message}`,
    });
  }

  const probeFailures = Array.isArray(result?.probeFailures)
    ? result.probeFailures.map((pf: any) => ({
        probe: String(pf?.probe || "unknown"),
        error: String(pf?.error || "unknown error"),
      }))
    : [];
  for (const pf of probeFailures) {
    log.warn(`PreFlight probe "${pf.probe}" failed: ${pf.error}`);
  }

  const rawFindings = Array.isArray(result?.findings) ? result.findings : [];
  const findings: PreFlightFinding[] = rawFindings.map((f: any) => ({
    // Unrecognized severities become "info", which would hide a more severe
    // finding, so record the original for the caller and the tests.
    severity: SEVERITIES.has(f?.severity) ? f.severity : "info",
    originalSeverity: SEVERITIES.has(f?.severity) ? undefined : String(f?.severity ?? "(missing)"),
    probe: String(f?.probe || "PreFlight"),
    title: String(f?.title || ""),
    file: String(f?.file || ""),
    line: typeof f?.line === "number" ? f.line : null,
    evidence: String(f?.evidence || "").slice(0, 500),
    remediation: String(f?.remediation || "").slice(0, 2000),
    // The engine attaches OWASP as an array; keep it one shape for the UI.
    owasp: Array.isArray(f?.owasp)
      ? f.owasp.map(String)
      : f?.owasp
        ? [String(f.owasp)]
        : undefined,
    cwe: f?.cwe ? String(f.cwe) : undefined,
  }));

  // The engine sorts by severity, then re-weights some findings afterward
  // (app-shape) without re-sorting, so the array can arrive out of order.
  // Sort here: the prompt digest caps by this order and must not spend its
  // budget on info findings while dropping criticals.
  findings.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }

  return {
    engine: "PreFlight",
    probeCount: safeProbeCount(),
    filesScanned: selected.length,
    filesSkipped: skipped,
    score: typeof result?.score === "number" ? result.score : 0,
    counts,
    findings,
    probeFailures,
    failed: null,
  };
}

// Compact, line-anchored digest of deterministic findings for injection into
// an LLM prompt as ground-truth evidence. Severity-ordered, capped so a noisy
// scan cannot crowd out the code itself.
export function formatFindingsForPrompt(report: PreFlightReport, maxFindings = 40): string {
  // Only claim a clean scan when the scan actually ran cleanly. Telling the
  // model "do not invent issues" after a failed or partial scan would suppress
  // the one layer that might still catch something.
  const incomplete = report.failed || report.probeFailures.length > 0;

  if (!report.findings.length) {
    if (incomplete) {
      return `PreFlight deterministic scan did not complete${report.failed ? ` (${report.failed})` : ` (${report.probeFailures.length} probe(s) failed)`}. Treat this as "not measured", not "clean", and analyze the code on its own merits.`;
    }
    return "PreFlight deterministic scan: no findings. Do not invent security or quality issues that the deterministic scan did not report unless you cite the exact code lines yourself.";
  }

  const lines: string[] = [
    `PreFlight deterministic static-analysis findings (${report.probeCount} probes, treat every entry below as verified ground truth with exact file/line anchors):`,
  ];
  for (const f of report.findings.slice(0, maxFindings)) {
    lines.push(
      `- [${f.severity.toUpperCase()}] ${f.probe}: ${f.title} (${f.file}${f.line ? `:${f.line}` : ""})`
    );
  }
  if (report.findings.length > maxFindings) {
    lines.push(`- ...and ${report.findings.length - maxFindings} more findings omitted for brevity.`);
  }
  if (incomplete) {
    lines.push(
      `- NOTE: the scan was incomplete (${report.probeFailures.length} probe(s) failed), so absence of a finding does not mean absence of a problem.`
    );
  }
  return lines.join("\n");
}
