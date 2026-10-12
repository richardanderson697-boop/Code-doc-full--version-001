// FinalRead stakeholder report builder — pure, deterministic, no model calls.
//
// Turns an audit result into the business-UI buckets the investor overlay
// shows: working / half-built / liability, a plain-English verdict, and the
// mandatory "what this review could not establish" panel. Everything here is
// derived from the report the engine already produced; nothing is invented.
//
// Shared between server (/api/finalread/ask rebuilds it per question) and
// client (FinalReadOverlay.tsx), so both sides always agree on the buckets.

export interface FinalReadFindingInput {
  severity: string; // critical | high | medium | low | info
  title: string;
  file: string;
  line: number | null;
  probe?: string;
  evidence?: string;
  /** The scanner's own fix text, when one exists. */
  remediation?: string;
}

export interface FinalReadCategoryInput {
  /** 0-10 deterministic rubric score. */
  score: number;
  reason?: string;
}

export interface FinalReadScanGaps {
  failed?: string | null;
  probeFailures?: Array<{ probe: string; error: string }>;
  filesSkipped?: Array<{ path: string; reason: string }>;
  filesScanned?: number;
}

export interface FinalReadAuditInput {
  projectTitle?: string;
  /** 0-100 completeness score. */
  completenessScore: number;
  categoryScores?: Record<string, FinalReadCategoryInput>;
  findings?: FinalReadFindingInput[];
  missingFeatures?: Array<{ category?: string; feature: string; reason?: string }>;
  scanGaps?: FinalReadScanGaps;
}

export interface FinalReadBucketItem {
  title: string;
  businessImplication: string;
  severity: string;
  file: string;
  line: number | null;
  /** The scanner's own remediation text, when the item came from a finding. */
  remediation?: string;
}

export interface FinalReadReport {
  projectTitle: string;
  verdict: string;
  completenessScore: number;
  working: FinalReadBucketItem[];
  halfBuilt: FinalReadBucketItem[];
  liabilities: FinalReadBucketItem[];
  /** Always non-empty: the report model requires this panel to show. */
  couldNotEstablish: string[];
  counts: { working: number; halfBuilt: number; liabilities: number };
}

// Plain-English business framing per rubric category: what the category
// means to a non-technical decision maker. Kept local (not imported from
// server/deterministic-score.ts) so this module stays dependency-free and
// importable by the client.
const CATEGORY_BUSINESS: Record<string, string> = {
  serverStarts: "whether the app reliably starts and keeps running",
  authentication: "who can log in, and whether accounts and sessions are real",
  databaseLayer: "where your data lives and whether it is stored safely",
  errorHandling: "what happens for a user when something goes wrong",
  coreLogic: "the main features the app promises to do",
  backgroundAutomation: "scheduled jobs and background work — emails, webhooks, queues",
  externalIntegrations: "connections to outside services such as payments",
  security: "protection against common attacks and data leaks",
  performance: "speed and behavior when many people use it at once",
  documentationVerified: "whether the docs match what the code actually does",
};

function categoryLabel(key: string): string {
  const words = key.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function businessLineForCategory(key: string): string {
  return CATEGORY_BUSINESS[key] || "this part of the app";
}

function implicationForCategory(key: string, score: number, reason?: string): string {
  const what = businessLineForCategory(key);
  const ev = reason && reason.trim() ? ` ${reason.trim()}` : "";
  if (score >= 7) {
    return `Solid ground (${score}/10): ${what} looks finished.${ev} Nothing here should worry a decision maker.`;
  }
  if (score >= 4) {
    return `Half-built (${score}/10): ${what} is partly there but not complete.${ev} Budget time and money to finish it before promising it to anyone.`;
  }
  return `A gap (${score}/10): ${what} is missing or broken.${ev} Treat this as unfinished work — do not launch on it or promise it to customers yet.`;
}

function implicationForFinding(f: FinalReadFindingInput): string {
  const sev = (f.severity || "info").toLowerCase();
  if (sev === "critical" || sev === "high") {
    return (
      `Flagged as ${sev} severity. In business terms, this is the kind of issue that becomes ` +
      `an incident, a breach headline, or an angry customer. It should be fixed before anyone bets on this app.`
    );
  }
  if (sev === "medium") {
    return (
      `Flagged as medium severity. Worth fixing before launch — left alone, issues like this ` +
      `tend to surface at the worst moment, usually in front of users.`
    );
  }
  return `A minor finding. Not a decision-maker's problem on its own, but worth handing to a developer with the rest.`;
}

function bucketForScore(score: number): "working" | "halfBuilt" | "liabilities" {
  if (score >= 7) return "working";
  if (score >= 4) return "halfBuilt";
  return "liabilities";
}

function verdictFor(completenessScore: number, liabilityCount: number): string {
  let v: string;
  if (completenessScore >= 80) {
    v =
      "This app looks substantially finished. The core areas scored well — " +
      "the items below are the exceptions worth a look before you commit.";
  } else if (completenessScore >= 50) {
    v =
      "This app is partly built. Several core areas are solid, but the gaps below are real — " +
      "anyone betting on it should price in the unfinished work.";
  } else {
    v =
      "This app has significant unfinished work. Treat it as early-stage: " +
      "it is not ready to carry real users or revenue yet.";
  }
  if (liabilityCount > 0) {
    v += ` Pay particular attention to the ${liabilityCount} ${liabilityCount === 1 ? "liability" : "liabilities"} — those are the reasons to pause.`;
  }
  return v;
}

function couldNotEstablishFor(input: FinalReadAuditInput): string[] {
  const out: string[] = [];
  const gaps = input.scanGaps || {};
  if (gaps.failed) {
    out.push(`The security scan itself failed (${gaps.failed}), so security findings below may be incomplete.`);
  }
  const probeFailures = gaps.probeFailures || [];
  if (probeFailures.length > 0) {
    out.push(
      `${probeFailures.length} security ${probeFailures.length === 1 ? "probe" : "probes"} could not run ` +
        `(${probeFailures.map((p) => p.probe).join(", ")}), so an empty result there does not mean the code is clean.`
    );
  }
  const skipped = gaps.filesSkipped || [];
  if (skipped.length > 0) {
    out.push(
      `${skipped.length} ${skipped.length === 1 ? "file was" : "files were"} excluded from the scan before it ran, ` +
        `so nothing is known about ${skipped.length === 1 ? "it" : "them"}.`
    );
  }
  // The standing honesty line: static analysis reads code, it never runs it.
  out.push(
    "This review is based on static analysis — the code was read, never executed. " +
      "Anything that only appears at runtime (real user traffic, production data, third-party outages) could not be established here."
  );
  return out;
}

export function buildFinalReadReport(input: FinalReadAuditInput): FinalReadReport {
  const working: FinalReadBucketItem[] = [];
  const halfBuilt: FinalReadBucketItem[] = [];
  const liabilities: FinalReadBucketItem[] = [];

  const categories = input.categoryScores || {};
  for (const key of Object.keys(categories)) {
    const cat = categories[key];
    const score = Math.max(0, Math.min(10, Math.round(Number(cat.score) || 0)));
    const item: FinalReadBucketItem = {
      title: categoryLabel(key),
      businessImplication: implicationForCategory(key, score, cat.reason),
      severity: score >= 7 ? "info" : score >= 4 ? "medium" : "high",
      file: "",
      line: null,
    };
    const bucket = bucketForScore(score);
    if (bucket === "working") working.push(item);
    else if (bucket === "halfBuilt") halfBuilt.push(item);
    else liabilities.push(item);
  }

  // Intended-but-missing features are half-built by definition.
  for (const m of input.missingFeatures || []) {
    halfBuilt.push({
      title: m.feature,
      businessImplication:
        `Planned but not built${m.category ? ` (${m.category})` : ""}. ` +
        (m.reason ? `${m.reason} ` : "") +
        `If anyone was promised this feature, that promise is currently unmet.`,
      severity: "medium",
      file: "",
      line: null,
    });
  }

  // PreFlight critical/high findings are liabilities; medium and below ride
  // along as context inside the liability bucket only when severe. Keep the
  // overlay honest: every liability names its file and line.
  for (const f of input.findings || []) {
    const sev = (f.severity || "info").toLowerCase();
    if (sev !== "critical" && sev !== "high") continue;
    liabilities.push({
      title: f.title,
      businessImplication: implicationForFinding(f),
      severity: sev,
      file: f.file,
      line: f.line,
      remediation: f.remediation,
    });
  }

  const couldNotEstablish = couldNotEstablishFor(input);
  const completenessScore = Math.max(0, Math.min(100, Math.round(Number(input.completenessScore) || 0)));

  return {
    projectTitle: (input.projectTitle || "").trim() || "Reviewed project",
    verdict: verdictFor(completenessScore, liabilities.length),
    completenessScore,
    working,
    halfBuilt,
    liabilities,
    couldNotEstablish,
    counts: { working: working.length, halfBuilt: halfBuilt.length, liabilities: liabilities.length },
  };
}
