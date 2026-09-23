// Shared shape of PreFlight deterministic scan results. The server adapter
// (server/preflight-scan.ts) produces these; UI components import them
// type-only, so nothing here reaches the client bundle.

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

export interface PreFlightFinding {
  severity: Severity;
  // Set only when the engine reported a severity outside the known set and the
  // adapter coerced it to "info". Present so a coerced critical is visible
  // rather than silently downgraded.
  originalSeverity?: string;
  probe: string;
  title: string;
  file: string;
  line: number | null;
  evidence: string;
  remediation: string;
  // The engine may map one probe to several OWASP categories.
  owasp?: string[];
  cwe?: string;
}

export interface ProbeFailure {
  probe: string;
  error: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface PreFlightReport {
  engine: "PreFlight";
  probeCount: number;
  filesScanned: number;
  // Files excluded before scanning (size or count limits, malformed entries).
  // Reported so the UI never implies coverage the scan did not have.
  filesSkipped: SkippedFile[];
  score: number;
  counts: Record<string, number>;
  findings: PreFlightFinding[];
  // Probes that threw. A non-empty list means the scan was partial, so an
  // empty findings array does NOT mean the code is clean.
  probeFailures: ProbeFailure[];
  // Set when the scan could not run at all; findings and score are meaningless.
  failed: string | null;
}

// True when the report cannot support a "no problems found" claim.
export function isScanIncomplete(report: PreFlightReport): boolean {
  return Boolean(report.failed) || report.probeFailures.length > 0 || report.filesSkipped.length > 0;
}
