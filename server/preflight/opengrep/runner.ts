// Opengrep layer for PreFlight: AST-aware security rules over the same files
// the vendored engine scans.
//
// Opengrep (opengrep.dev) is the LGPL-2.1 community fork of Semgrep's engine,
// maintained by a vendor consortium. It runs as a separate subprocess, so the
// LGPL does not reach this codebase. The rule pack is ours
// (server/preflight/opengrep/rules/): never point this at Semgrep's official
// registry (`p/...`, `--config auto`) for customer scans -- the Dec-2024
// Semgrep Rules License forbids running those packs as a service.
//
// Contract, mirroring the adapter in ../preflight-scan.ts:
// - NEVER throws. A missing binary degrades silently (the install step is
//   optional for local dev); a present-but-failing binary is reported as a
//   probe failure so callers say "not measured", not "clean".
// - Synchronous: the vendored engine already blocks the request thread, so
//   this stays sync until the scan moves off-thread. Bounded by
//   OPENGREP_TIMEOUT_MS (default 20s).
// - Findings come back with project-relative file paths, matching the shape
//   the adapter and the UI expect.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, sep } from "node:path";
import { log } from "../../logger";
import { SEVERITY_ORDER, type PreFlightFinding, type ProbeFailure, type Severity } from "../../../shared/preflight-types";

export interface OpengrepInputFile {
  path: string;
  content: string;
}

export interface OpengrepResult {
  findings: PreFlightFinding[];
  // Set when the binary exists but the scan could not complete. Null when the
  // binary is absent (silent degradation) or the scan succeeded.
  failure: ProbeFailure | null;
  rulesRun: number;
}

// Pinned engine version. Keep in sync with scripts/install-opengrep.sh.
export const OPENGREP_VERSION = "1.30.0";

const TIMEOUT_MS = Number(process.env.OPENGREP_TIMEOUT_MS) || 20000;

let cachedBinary: string | null | undefined;
let warnedMissing = false;

function binaryIsUsable(p: string): boolean {
  try {
    execFileSync(p, ["--version"], { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Resolve the engine binary: explicit env override, then the install script's
// location (./bin/opengrep, works in dev and in the deployed image), then
// PATH. Result is cached for the process lifetime.
export function resolveOpengrepBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  const candidates: string[] = [];
  if (process.env.OPENGREP_PATH) candidates.push(process.env.OPENGREP_PATH);
  candidates.push(join(process.cwd(), "bin", "opengrep"));
  if (process.platform === "win32") candidates.push(join(process.cwd(), "bin", "opengrep.exe"));
  for (const c of candidates) {
    try {
      if (existsSync(c) && binaryIsUsable(c)) {
        cachedBinary = c;
        return c;
      }
    } catch {
      // try the next candidate
    }
  }
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["opengrep"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: "pipe",
    })
      .trim()
      .split(/\r?\n/)[0];
    if (found && binaryIsUsable(found)) {
      cachedBinary = found;
      return found;
    }
  } catch {
    // no usable binary on PATH
  }
  cachedBinary = null;
  return null;
}

// The rule pack ships with the server source and is deployed with the project
// directory, so it resolves from the working directory in dev and in the
// Railway image alike. Overridable for tests via OPENGREP_RULES_DIR.
export function resolveRulesDir(): string | null {
  const override = process.env.OPENGREP_RULES_DIR;
  if (override && existsSync(override)) return override;
  const dir = join(process.cwd(), "server", "preflight", "opengrep", "rules");
  return existsSync(dir) ? dir : null;
}

function countRules(rulesDir: string): number {
  let count = 0;
  try {
    for (const name of readdirSync(rulesDir)) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      const text = readFileSync(join(rulesDir, name), "utf8");
      for (const line of text.split("\n")) {
        if (/^\s{2}-\s+id:\s*\S/.test(line)) count++;
      }
    }
  } catch {
    // best effort; a wrong count here must not break the scan
  }
  return count;
}

// Stage the selected files into a temp dir for the subprocess. Paths come
// from user uploads, so anything that would escape the staging dir is
// dropped, never written.
function stageFiles(files: OpengrepInputFile[]): { dir: string; staged: number } {
  const dir = mkdtempSync(join(tmpdir(), "preflight-opengrep-"));
  let staged = 0;
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
    const full = normalize(join(dir, f.path));
    if (full !== dir && !full.startsWith(dir + sep)) continue;
    try {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.content, "utf8");
      staged++;
    } catch {
      // one bad file must not sink the scan
    }
  }
  return { dir, staged };
}

const OG_SEVERITY: Record<string, Severity> = {
  ERROR: "high",
  WARNING: "medium",
  INFO: "info",
};

function toFinding(r: any, rootDir: string): PreFlightFinding | null {
  if (!r || typeof r !== "object") return null;
  const checkId = String(r.check_id || "");
  const ruleId = checkId.split(".").pop() || checkId || "unknown";
  const extra = r.extra && typeof r.extra === "object" ? r.extra : {};
  const meta = extra.metadata && typeof extra.metadata === "object" ? extra.metadata : {};
  const ogSeverity = String(extra.severity || "INFO").toUpperCase();
  let severity: Severity = OG_SEVERITY[ogSeverity] || "info";
  // Rules can pin their own PreFlight severity (e.g. hardcoded secret ->
  // critical); validated so a typo cannot smuggle in an unknown severity.
  const override = String(meta.gradevibes_severity || "");
  if ((SEVERITY_ORDER as readonly string[]).includes(override)) {
    severity = override as Severity;
  }
  // Report the project-relative path, matching the vendored engine's shape.
  let file = String(r.path || "");
  try {
    const rel = relative(rootDir, file);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) file = rel;
  } catch {
    // keep the absolute path rather than dropping the finding
  }
  return {
    severity,
    probe: `opengrep:${ruleId}`,
    title: String(extra.message || ruleId).replace(/\s+/g, " ").trim().slice(0, 300),
    file,
    line: typeof r.start?.line === "number" ? r.start.line : null,
    evidence: String(extra.lines || "").trim().slice(0, 500),
    remediation: String(meta.fix || "").slice(0, 2000),
    owasp: meta.owasp ? [String(meta.owasp)] : undefined,
    cwe: meta.cwe ? String(meta.cwe) : undefined,
  };
}

function parseResults(stdout: string, rootDir: string): PreFlightFinding[] {
  const parsed = JSON.parse(stdout);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const findings: PreFlightFinding[] = [];
  for (const r of results) {
    const f = toFinding(r, rootDir);
    if (f) findings.push(f);
  }
  return findings;
}

export function runOpengrepScan(files: OpengrepInputFile[]): OpengrepResult {
  if (process.env.OPENGREP_DISABLED === "1") {
    return { findings: [], failure: null, rulesRun: 0 };
  }
  const binary = resolveOpengrepBinary();
  const rulesDir = resolveRulesDir();
  if (!binary || !rulesDir) {
    // The binary is an enhancement layer, not a requirement: without it the
    // scan behaves exactly as it did before this integration. Warn once for
    // ops visibility, then stay quiet.
    if (!warnedMissing) {
      warnedMissing = true;
      log.warn(
        `Opengrep layer inactive (${!binary ? "binary not found" : "rules dir not found"}); ` +
          `PreFlight running on the vendored engine only.`
      );
    }
    return { findings: [], failure: null, rulesRun: 0 };
  }

  const rulesRun = countRules(rulesDir);
  const { dir, staged } = stageFiles(files);
  if (staged === 0) {
    rmSync(dir, { recursive: true, force: true });
    return { findings: [], failure: null, rulesRun };
  }
  try {
    const stdout = execFileSync(
      binary,
      ["scan", "--config", rulesDir, "--json", "--quiet", dir],
      { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", stdio: "pipe" }
    );
    return { findings: parseResults(stdout, dir), failure: null, rulesRun };
  } catch (err: any) {
    // Opengrep exits 0 even with findings, but tolerate a nonzero exit that
    // still produced JSON on stdout (defensive; observed exit codes vary).
    const raw = err?.stdout;
    const text = typeof raw === "string" ? raw : raw?.toString?.("utf8") || "";
    if (text.trim().startsWith("{")) {
      try {
        return { findings: parseResults(text, dir), failure: null, rulesRun };
      } catch {
        // fall through to the failure report
      }
    }
    const reason =
      err?.code === "ETIMEDOUT"
        ? `timed out after ${TIMEOUT_MS}ms`
        : String(err?.message || err || "unknown error").slice(0, 300);
    log.warn(`Opengrep scan failed (${reason}); continuing without the AST layer.`);
    return { findings: [], failure: { probe: "opengrep", error: reason }, rulesRun };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
