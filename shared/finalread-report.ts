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
  /**
   * Set when the probe could not establish the finding (e.g. a delegated
   * handler whose auth lives outside the scanned file). Flagged findings
   * never become liabilities — they route to needsVerification instead.
   */
  unverified?: boolean;
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

/** One per-file ledger entry from the intelligence run: what the file is
 *  and what it contributes. Warehouse detail — carried for the Q&A, never
 *  rendered in the stakeholder UI. */
export interface FinalReadFileLedgerEntry {
  filePath: string;
  lineCount?: number;
  description?: string;
  contribution?: string;
}

/** The intelligence run's structured application map (entrypoint, key
 *  components with their imports, backend endpoints with purposes).
 *  Warehouse detail — carried for the Q&A, never rendered in the UI. */
export interface FinalReadApplicationMap {
  entrypoint?: string;
  components?: Array<{ name: string; filePath: string; imports?: string[] }>;
  endpoints?: Array<{ method: string; path: string; purpose?: string }>;
}

export interface FinalReadAuditInput {
  projectTitle?: string;
  /** 0-100 completeness score. */
  completenessScore: number;
  /** Plain-English description of what the app is/does (the workspace
   *  intelligence "overall summary"). Lets the Q&A answer in terms of the
   *  app's actual function instead of generic bucket contents. */
  applicationSummary?: string;
  categoryScores?: Record<string, FinalReadCategoryInput>;
  /** Deterministic per-category evidence lines (file:line anchors and signal
   *  descriptions, from the intelligence route's deterministic assessment).
   *  Plumbs the scan's raw signals through to Q&A context so "which?"
   *  questions have something to stand on. */
  categoryEvidence?: Record<string, string[]>;
  findings?: FinalReadFindingInput[];
  missingFeatures?: Array<{ category?: string; feature: string; reason?: string }>;
  scanGaps?: FinalReadScanGaps;
  /** Warehouse detail from the intelligence run: the structured
   *  application map. The stakeholder UI never displays it, but the Q&A
   *  context includes it so "how is X wired up" questions can retrieve
   *  what the analysis established instead of declining. */
  applicationMap?: FinalReadApplicationMap;
  /** Warehouse detail from the intelligence run: the per-file ledger.
   *  Same deal as applicationMap — retrievable by the Q&A, not displayed. */
  fileLedger?: FinalReadFileLedgerEntry[];
}

export interface FinalReadBucketItem {
  title: string;
  businessImplication: string;
  severity: string;
  file: string;
  line: number | null;
  /** Condensed deterministic evidence lines (category items only). */
  evidence?: string[];
  /** The scanner's own remediation text, when the item came from a finding. */
  remediation?: string;
  /**
   * Present only on needsVerification items: the four fields the
   * developer-verification section renders. Never invent a check — when
   * the finding carries no remediation, howToCheck is the generic
   * ask-the-developer fallback.
   */
  verification?: {
    /** What the scan saw: file:line plus probe evidence. */
    whatWeSaw: string;
    /** The severity implication, framed conditionally (never asserted). */
    ifReal: string;
    /** How a developer checks it (finding remediation or generic fallback). */
    howToCheck: string;
    /** What each answer means: confirmed → liability, refuted → leaves the list. */
    whatEachAnswerMeans: string;
  };
}

export interface FinalReadReport {
  projectTitle: string;
  verdict: string;
  completenessScore: number;
  /** What the app is/does, when the audit provided it. */
  applicationSummary?: string;
  working: FinalReadBucketItem[];
  halfBuilt: FinalReadBucketItem[];
  liabilities: FinalReadBucketItem[];
  /**
   * Findings the probe flagged but could not establish. Never liabilities,
   * never hidden — the stakeholder UI renders these in their own section.
   * Ordered severity-desc, then file order.
   */
  needsVerification: FinalReadBucketItem[];
  /** ISO timestamp the report object was built (rendered in the verification section header). */
  generatedAt: string;
  /** Always non-empty: the report model requires this panel to show. */
  couldNotEstablish: string[];
  counts: { working: number; halfBuilt: number; liabilities: number; needsVerification: number };
  /** Warehouse detail (Q&A-only, never rendered): the intelligence run's
   *  application map, when the audit provided a usable one. */
  applicationMap?: FinalReadApplicationMap;
  /** Warehouse detail (Q&A-only, never rendered): the per-file ledger. */
  fileLedger?: FinalReadFileLedgerEntry[];
  /** The assessor's raw per-category reasons, keyed by category. The
   *  bucket items already fold these into business implications; carrying
   *  them verbatim lets the Q&A stand on the review's own technical basis
   *  (citations included) when a stakeholder asks how something is handled.
   *  Derived from categoryScores — the single source of truth — rather
   *  than a second input field that could disagree with the scores. */
  categoryReasons?: Record<string, string>;
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

/**
 * The severity implication for a verification item, framed conditionally.
 * Mirrors implicationForFinding's branches but never asserts the issue is
 * real — the item is flagged, not established.
 */
function ifRealForFinding(f: FinalReadFindingInput): string {
  const sev = (f.severity || "info").toLowerCase();
  if (sev === "critical" || sev === "high") {
    return (
      `If confirmed, this is the kind of issue that becomes an incident, ` +
      `a breach headline, or an angry customer. It should be fixed before anyone bets on this app.`
    );
  }
  if (sev === "medium") {
    return (
      `If confirmed, worth fixing before launch — left alone, issues like this ` +
      `tend to surface at the worst moment, usually in front of users.`
    );
  }
  return `If confirmed, a minor issue — not a decision-maker's problem on its own, but worth handing to a developer with the rest.`;
}

function verdictFor(completenessScore: number, liabilityCount: number, verificationCount = 0): string {
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
  } else if (verificationCount > 0) {
    // Plain sentence only: verification items are flagged, not established,
    // so they never read as "reasons to pause" on their own.
    v += ` There ${verificationCount === 1 ? "is" : "are"} ${verificationCount} ${verificationCount === 1 ? "item" : "items"} flagged for developer verification below — none counted as a liability until confirmed.`;
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

// Condense raw deterministic evidence lines for the report and Q&A
// context: cap count, trim length, drop empties. The raw arrays can be
// long; the model prompt must stay bounded.
const MAX_EVIDENCE_LINES = 6;
const MAX_EVIDENCE_CHARS = 180;

function condenseEvidence(lines: unknown): string[] | undefined {
  if (!Array.isArray(lines)) return undefined;
  const out: string[] = [];
  for (const l of lines) {
    const s = String(l ?? "").trim();
    if (!s) continue;
    out.push(s.length > MAX_EVIDENCE_CHARS ? s.slice(0, MAX_EVIDENCE_CHARS - 1) + "…" : s);
    if (out.length >= MAX_EVIDENCE_LINES) break;
  }
  return out.length > 0 ? out : undefined;
}

// Warehouse sanitizers: the audit arrives from the client, so the
// warehouse fields get the same defensive treatment as everything else
// here — wrong container shapes and junk entries drop to undefined
// instead of reaching the Q&A context (or throwing).

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function cleanString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function sanitizeApplicationMap(raw: unknown): FinalReadApplicationMap | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: FinalReadApplicationMap = {};
  const entrypoint = cleanString(raw.entrypoint);
  if (entrypoint) out.entrypoint = entrypoint;
  if (Array.isArray(raw.components)) {
    const components: NonNullable<FinalReadApplicationMap["components"]> = [];
    for (const c of raw.components) {
      if (!isPlainObject(c)) continue;
      const name = cleanString(c.name);
      const filePath = cleanString(c.filePath);
      if (!name && !filePath) continue;
      const imports = Array.isArray(c.imports)
        ? c.imports.map((i) => cleanString(i)).filter((i): i is string => !!i)
        : undefined;
      components.push({
        name: name || "",
        filePath: filePath || "",
        ...(imports && imports.length > 0 ? { imports } : {}),
      });
    }
    if (components.length > 0) out.components = components;
  }
  if (Array.isArray(raw.endpoints)) {
    const endpoints: NonNullable<FinalReadApplicationMap["endpoints"]> = [];
    for (const e of raw.endpoints) {
      if (!isPlainObject(e)) continue;
      const method = cleanString(e.method);
      const path = cleanString(e.path);
      if (!method || !path) continue;
      const purpose = cleanString(e.purpose);
      endpoints.push({ method, path, ...(purpose ? { purpose } : {}) });
    }
    if (endpoints.length > 0) out.endpoints = endpoints;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeFileLedger(raw: unknown): FinalReadFileLedgerEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FinalReadFileLedgerEntry[] = [];
  for (const e of raw) {
    if (!isPlainObject(e)) continue;
    const filePath = cleanString(e.filePath);
    if (!filePath) continue;
    const entry: FinalReadFileLedgerEntry = { filePath };
    const lineCount = Number(e.lineCount);
    if (Number.isFinite(lineCount) && lineCount > 0) entry.lineCount = Math.round(lineCount);
    const description = cleanString(e.description);
    if (description) entry.description = description;
    const contribution = cleanString(e.contribution);
    if (contribution) entry.contribution = contribution;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function deriveCategoryReasons(
  categories: Record<string, FinalReadCategoryInput>
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const key of Object.keys(categories)) {
    const reason = (categories[key]?.reason || "").trim();
    if (reason) out[key] = reason;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildFinalReadReport(input: FinalReadAuditInput): FinalReadReport {
  const working: FinalReadBucketItem[] = [];
  const halfBuilt: FinalReadBucketItem[] = [];
  const liabilities: FinalReadBucketItem[] = [];
  const needsVerification: FinalReadBucketItem[] = [];

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
      evidence: condenseEvidence(input.categoryEvidence?.[key]),
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

  // PreFlight critical/high findings are liabilities — unless the probe
  // flagged them as unverified, in which case they route to the
  // verification bucket instead, regardless of severity: never
  // liabilities, never hidden. Medium and below ride along as context
  // inside the liability bucket only when severe. Keep the overlay
  // honest: every liability names its file and line.
  for (const f of input.findings || []) {
    const sev = (f.severity || "info").toLowerCase();
    if (f.unverified === true) {
      needsVerification.push({
        title: f.title,
        businessImplication:
          `Flagged by the scan but not established from the code reviewed. ` +
          `A developer still needs to confirm or refute it — until then it counts neither for nor against this app.`,
        severity: sev,
        file: f.file,
        line: f.line,
        remediation: f.remediation,
        verification: {
          whatWeSaw: `Flagged at ${f.file}${f.line != null ? `:${f.line}` : ""}${f.probe ? ` (${f.probe})` : ""}${f.evidence ? ` — ${f.evidence}` : ""}`,
          ifReal: ifRealForFinding(f),
          howToCheck:
            f.remediation ||
            `Ask the developer to confirm whether this holds, and to point at the code that settles it.`,
          whatEachAnswerMeans: `Confirmed → it becomes a liability. Refuted → it leaves this list.`,
        },
      });
      continue;
    }
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

  // Verification items order severity-desc, then file order (stable sort
  // preserves input order within a severity).
  const sevRank = (s: string) =>
    ({ critical: 0, high: 1, medium: 2, low: 3, info: 4 })[s] ?? 5;
  needsVerification.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));

  const couldNotEstablish = couldNotEstablishFor(input);
  const completenessScore = Math.max(0, Math.min(100, Math.round(Number(input.completenessScore) || 0)));

  return {
    projectTitle: (input.projectTitle || "").trim() || "Reviewed project",
    verdict: verdictFor(completenessScore, liabilities.length, needsVerification.length),
    completenessScore,
    applicationSummary: (input.applicationSummary || "").trim() || undefined,
    working,
    halfBuilt,
    liabilities,
    needsVerification,
    generatedAt: new Date().toISOString(),
    couldNotEstablish,
    counts: {
      working: working.length,
      halfBuilt: halfBuilt.length,
      liabilities: liabilities.length,
      needsVerification: needsVerification.length,
    },
    applicationMap: sanitizeApplicationMap(input.applicationMap),
    fileLedger: sanitizeFileLedger(input.fileLedger),
    categoryReasons: deriveCategoryReasons(categories),
  };
}
