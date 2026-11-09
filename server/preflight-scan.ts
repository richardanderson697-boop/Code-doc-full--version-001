// Typed adapter over the vendored PreFlight engine (see preflight/VENDORED.md).
//
// The engine's per-probe try/catch protects the probe loop, but steps outside
// that loop (repo-config suppression parsing, scoring) are unguarded, and a
// malformed .preflight.json in scanned input can throw from scan() itself.
// This adapter is the containment boundary: runPreFlightScan NEVER throws.
// A scan failure degrades to an empty report carrying `failed`, so callers
// keep serving and the UI can say "not measured" instead of "clean".
import { scan, engineInfo } from "./preflight/vendor/lib/cockpit-scan.js";
import { runOpengrepScan } from "./preflight/opengrep/runner";
import { log } from "./logger";
import { PreFlightFinding, PreFlightReport, SEVERITY_ORDER } from "../shared/preflight-types";

// Cross-file probe pass (finalread-cross-file-probe-batching-spec.md §4):
// probe functions run directly over the full selected set. Imported from the
// vendored engine, never edited (VENDORED.md: fixes belong upstream).
import {
  probePackageJson,
  probeNpmrcHygiene,
} from "./preflight/vendor/lib/probes/supply-chain.js";
import { probeArchitecture } from "./preflight/vendor/lib/probes/quality.js";
import { probeMissingHeaders } from "./preflight/vendor/lib/probes/transport.js";
import { probeHostDetection } from "./preflight/vendor/lib/probes/v2/context.js";
import { probeSupabaseRLS } from "./preflight/vendor/lib/probes/database.js";
import {
  probeExternalURLs,
  probeGEOHygiene,
  isPrivatePWAContext,
} from "./preflight/vendor/lib/probes/web.js";
import { isTestFile } from "./preflight/vendor/lib/file-filter.js";
import {
  detectAppShape,
  applyAppShape,
} from "./preflight/vendor/lib/probes/v2/app-shape.js";
import { computeScore } from "./preflight/vendor/lib/scoring.js";

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

// ---------------------------------------------------------------------------
// Cross-file probe pass (finalread-cross-file-probe-batching-spec.md §4-§6).
// Batched scans hand the engine 2 files at a time, so any probe whose truth
// depends on the file set as a whole can misfire on a partial set. The pass
// runs the cross-file probes once over the full selected set, and the batch
// filter drops the findings those probes can never authoritatively emit.
// ---------------------------------------------------------------------------

// Budget for the cross-file pass (spec §4). The pass shares the scan's wall
// clock and abandons if it cannot finish inside this cap; the tier-1 filter
// still applies when it does. Confirmed by measurement on the self-scan repo
// in the acceptance notes.
export const CROSS_FILE_PASS_BUDGET_MS = 2000;

// Tier 1 — cross-file finding id prefixes (spec §5, audit table). A finding
// with one of these ids asserts something about the file set as a whole, so a
// batched (partial-set) run can never authoritatively emit it. Dropped from
// batch findings always. Entries ending in "-" match by prefix; other entries
// match exactly.
export const CROSS_FILE_FINDING_ID_PREFIXES = [
  // probeArchitecture
  "arch-classify-",
  "arch-monolith-split",
  "arch-static-html-teach",
  "arch-monorepo-teach",
  // probeNpmrcHygiene
  "npmrc-missing",
  "npmrc-cooldown-",
  // probeMissingHeaders
  "headers-next-static-export-",
  "headers-missing-",
  "headers-missing-frame-ancestors-",
  "headers-",
  // probeHostDetection
  "host-detection",
  // probePackageJson (cross-file part)
  "pkg-entry-not-scanned-",
  "pkg-nonregistry-",
  // probeSupabaseRLS (client-reads part)
  "rls-client-unprotected-",
  // probeExternalURLs
  "url-",
  // probeGEOHygiene (cross-file part)
  "geo-no-llmstxt",
  "geo-schema-drift-faq",
] as const;

// Tier 2 — per-file finding id prefixes of probes the pass runs (spec §5).
// The pass already emitted these authoritatively over the full set, so batch
// copies are duplicates. Dropped from batch findings only when the pass ran.
export const PASS_PROBE_PER_FILE_ID_PREFIXES = [
  // probePackageJson (per-file part)
  "pkg-postinstall-",
  "pkg-floating-",
  // probeSupabaseRLS (per-table part)
  "rls-",
  "rls-permissive-",
  "rls-permissive-check-",
  "rls-disabled-",
  "rls-securitydefiner-",
  // probeGEOHygiene (per-file part)
  "geo-block-",
  "geo-no-freshness",
] as const;

function matchesIdPrefix(id: unknown, prefixes: readonly string[]): boolean {
  if (typeof id !== "string") return false;
  return prefixes.some((p) => (p.endsWith("-") ? id.startsWith(p) : id === p));
}

// Corpus-middleware gate, same shapes as probeAPIRouteAuth
// (server/preflight/vendor/lib/probes/auth.js:1546-1575). First-party copy;
// the gate-agreement test guards drift.
function hasRouteAuthCorpusMiddleware(files: ScanInputFile[]): boolean {
  return files.some((mf) => {
    if (!/(^|\/)(src\/)?middleware\.[jt]sx?$/.test(mf.path)) return false;
    if (typeof mf.content !== "string") return false;
    return /(clerkMiddleware|withAuth|getServerSession|getUser|currentUser|requireAuth|\bauth\s*\(|verifyToken|jwt\.verify\s*\([^,)]+,)/i.test(
      mf.content
    );
  });
}

function hasAppWideAuthMiddleware(files: ScanInputFile[]): boolean {
  return files.some((mf) => {
    if (typeof mf.content !== "string") return false;
    if (isTestFile(mf.path)) return false;
    return (
      /\b(?:app|router)\.use\s*\(\s*(?:['"`][^'"`]*['"`]\s*,\s*)?(?:authenticate|authMiddleware|requireAuth|isAuthenticated|verifyJWT|verifyToken|protect|guard|passport\.authenticate|clerkMiddleware|withAuth)/i.test(
        mf.content
      ) ||
      /\bapp\.use\s*\(\s*['"`]\*['"`]\s*,\s*(?:jwt|bearerAuth|basicAuth|auth)\s*\(/i.test(
        mf.content
      )
    );
  });
}

// Corpus-middleware gate, same shape as probeAdminRoutes
// (server/preflight/vendor/lib/probes/auth.js:858-866). Note the token list
// differs from probeAPIRouteAuth's (no getUser, no jwt.verify) — the gates
// are evaluated separately, exactly.
function hasAdminCorpusMiddleware(files: ScanInputFile[]): boolean {
  return files.some(
    (mf) =>
      /(^|\/)(src\/)?middleware\.[jt]sx?$/.test(mf.path) &&
      typeof mf.content === "string" &&
      /(clerkMiddleware|withAuth|getServerSession|currentUser|requireAuth|\bauth\s*\(|verifyToken)/i.test(
        mf.content
      )
  );
}

// Hybrid gates (spec §6). Each entry pairs the finding id prefixes belonging
// to one probe with its corpus gate over the full selected set. When the gate
// is true, the full-set probe would emit nothing, so batch findings from that
// probe are dropped; when false, they are kept.
interface HybridGate {
  prefixes: readonly string[];
}

function evaluateHybridGates(files: ScanInputFile[]): HybridGate[] {
  const active: HybridGate[] = [];
  if (hasRouteAuthCorpusMiddleware(files) || hasAppWideAuthMiddleware(files)) {
    active.push({ prefixes: ["api-noauth-", "api-destructive-"] });
  }
  if (hasAdminCorpusMiddleware(files)) {
    active.push({ prefixes: ["admin-clientonly-"] });
  }
  if (isPrivatePWAContext(files)) {
    active.push({
      prefixes: ["seo-", "seo-robots-no-sitemap-", "seo-robots-disallow-all-"],
    });
  }
  return active;
}

type CrossFileProbeFn = (files: ScanInputFile[]) => any[];

const CROSS_FILE_PASS_PROBES: CrossFileProbeFn[] = [
  probePackageJson,
  probeArchitecture,
  probeNpmrcHygiene,
  probeMissingHeaders,
  probeHostDetection,
  probeSupabaseRLS,
  probeExternalURLs,
  probeGEOHygiene,
];

interface CrossFilePassOutcome {
  findings: any[];
  score: number;
  ran: boolean;
  durationMs: number;
  failures: { probe: string; error: string }[];
}

// Full-set cross-file pass (spec §4). Runs the pure and hybrid cross-file
// probes once over the full selected set and applies the engine's
// post-processing (detectAppShape / applyAppShape / computeScore) via the
// vendored helpers. A probe that throws is recorded and skipped, mirroring
// scan()'s per-probe handling; a budget overrun abandons the pass entirely
// (no pass findings, ran false) and records a probeFailures entry.
function runCrossFilePass(
  selected: ScanInputFile[],
  started: number,
  budgetMs: number
): CrossFilePassOutcome {
  const passStarted = Date.now();
  const raw: any[] = [];
  const failures: { probe: string; error: string }[] = [];
  for (const probe of CROSS_FILE_PASS_PROBES) {
    // Own cap on the scan's shared wall clock, checked between probes. A
    // single probe cannot be interrupted mid-call — same limitation as the
    // batch loop's deadline check.
    if (Date.now() - started >= budgetMs) {
      return {
        findings: [],
        score: 100,
        ran: false,
        durationMs: Date.now() - passStarted,
        failures: [
          ...failures,
          {
            probe: "cross-file-pass",
            error: `cross-file probe pass exceeded its ${budgetMs}ms budget and did not run`,
          },
        ],
      };
    }
    try {
      const found = probe(selected);
      if (Array.isArray(found)) raw.push(...found);
    } catch (err: any) {
      failures.push({
        probe: probe.name || "cross-file-probe",
        error: err?.message || String(err),
      });
    }
  }
  // Post-processing mirroring scan() steps 5b-6. Snippets / stable ids /
  // probe meta are not replicated: the adapter's finding mapping drops them,
  // exactly as it does for batch findings.
  const shape = detectAppShape(selected);
  const shaped = applyAppShape(raw, shape);
  return {
    findings: shaped,
    score: computeScore(shaped),
    ran: true,
    durationMs: Date.now() - passStarted,
    failures,
  };
}

// Batch filter (spec §5). Applied to raw batch findings BEFORE the adapter's
// mapping (the mapping drops the finding id). Tier 1 always; tier 2 and the
// hybrid gates only when the pass / gate applies.
function filterBatchFindings(
  findings: any[],
  passRan: boolean,
  gatesActive: HybridGate[]
): any[] {
  return findings.filter((f) => {
    const id = typeof f?.id === "string" ? f.id : "";
    if (matchesIdPrefix(id, CROSS_FILE_FINDING_ID_PREFIXES)) return false;
    if (passRan && matchesIdPrefix(id, PASS_PROBE_PER_FILE_ID_PREFIXES)) return false;
    for (const g of gatesActive) {
      if (matchesIdPrefix(id, g.prefixes)) return false;
    }
    return true;
  });
}

export interface RunPreFlightScanOptions {
  // Test seam: byte threshold for the single-pass path (default
  // SINGLE_PASS_BYTES). Tests force the batched path with a tiny value.
  singlePassBytes?: number;
  // Test seam: budget for the cross-file pass in ms (default
  // CROSS_FILE_PASS_BUDGET_MS).
  crossFilePassBudgetMs?: number;
}

/**
 * Main entry point for preflight scanning. Runs a 384KB+ repo in batches of
 * 2 files through the vendored engine (per-file findings, coverage-only risk),
 * with the cross-file pass (§4) and batch filter (§5, §6) so cross-file
 * findings match a single-pass run, then runs the Opengrep AST probe
 * (repo-wide, server-side). Returns a normalized, severity-sorted report
 * with deduplicated findings.
 */
export function runPreFlightScan(
  files: ScanInputFile[],
  engine: ScanEngine = scan,
  options: RunPreFlightScanOptions = {}
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
    const singlePassBytes = options.singlePassBytes ?? SINGLE_PASS_BYTES;
    if (totalBytes <= singlePassBytes) {
      result = engine(selected);
    } else {
      result = { findings: [], probeFailures: [], score: 0 };
      // Cross-file pass (spec §4): pure/hybrid cross-file probes run once
      // over the full selected set, before batching. Batched path only.
      const pass = runCrossFilePass(
        selected,
        started,
        options.crossFilePassBudgetMs ?? CROSS_FILE_PASS_BUDGET_MS
      );
      if (pass.failures.length > 0) {
        result.probeFailures.push(...pass.failures);
      }
      // Hybrid gates (spec §6), evaluated once over the full selected set.
      const gatesActive = evaluateHybridGates(selected);
      let i = 0;
      for (; i < selected.length; i += BATCH_SIZE) {
        if (Date.now() - started > MAX_SCAN_MS) break;
        const part = engine(selected.slice(i, i + BATCH_SIZE));
        const batchFindings = filterBatchFindings(
          part.findings || [],
          pass.ran,
          gatesActive
        );
        result.findings.push(...batchFindings);
        result.probeFailures.push(...(part.probeFailures || []));
        result.score = typeof part.score === "number" ? Math.min(result.score || 100, part.score) : result.score;
      }
      // Merge the authoritative cross-file findings and their score.
      if (pass.ran) {
        result.findings.push(...pass.findings);
        result.score = Math.min(result.score || 100, pass.score);
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
    // Probes flag findings they could not establish (delegated handlers);
    // the flag must survive the adapter or the verification guard below
    // has nothing to route on. Never inferred from title text.
    unverified: f?.unverified === true ? true : undefined,
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
  //
  // Opengrep pass: AST-aware rules from the first-party pack, over the same
  // selected files. Degrades silently when the binary is absent (local dev
  // without the install step); a present-but-failing binary is recorded as a
  // probe failure so the report says "not measured" instead of "clean".
  // The engine's score is kept as-is: opengrep findings do not move it yet
  // (follow-up: unified scoring).
  const og = runOpengrepScan(selected);
  if (og.failure) {
    probeFailures.push(og.failure);
    log.warn(`PreFlight probe "opengrep" failed: ${og.failure.error}`);
  }
  findings.push(...og.findings);
  findings.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }

  return {
    engine: "PreFlight",
    probeCount: safeProbeCount() + og.rulesRun,
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
