// FinalRead Q&A guardrails — pure, deterministic, no model calls.
//
// Decides which stakeholder questions get a free fixed reply, which go to
// the model, and whether a model answer is grounded enough to charge for.
// Shared between the server route and tests so the charging rules have one
// definition.

import type { FinalReadReport } from "./finalread-report";

/** Cost / time / effort questions always get the fixed no-estimates reply:
 *  no model call, no charge. The packet schema forbids effort estimates in
 *  v1, so the Q&A must not invent them either. */
const NO_ESTIMATES_PATTERN =
  /\b(cost|price|pricing|how much|how long|timeline|timeframe|estimate|estimation|effort|story points|man[- ]?hours|deadline|how fast)\b/i;

export function isNoEstimatesQuestion(question: string): boolean {
  return NO_ESTIMATES_PATTERN.test(question || "");
}

export const NO_ESTIMATES_REPLY =
  "I don't give cost or time estimates — by design, this review never includes them. " +
  "What I can tell you is what needs fixing and in what order: start with the liabilities, " +
  "then the half-built areas. Your developer can scope the work from the handoff packet.";

/** Runtime questions — answerable only by watching the app run, never from a
 *  static review. Routed deterministically to the fixed runtime reply, the
 *  same way no-estimates questions are: no model call, no charge. The model
 *  proved it can't classify these reliably itself (asked "what happens if my
 *  server goes down", it answered with the previous question's line numbers
 *  instead of the runtime tier), so classification happens here, not in the
 *  prompt. Patterns are deliberately scenario-flavored ("what happens if the
 *  X goes down") rather than bare nouns, so static questions about servers,
 *  files, or restart policy in the code still reach the model. */
const RUNTIME_PATTERNS = [
  /\bwhat happens if\b/i,
  /\bwhat happens when\b/i,
  /\bgo(es)? down\b/i,
  /\bserver (is |was )?down\b/i,
  /\bcrash(es|ed|ing)?\b/i,
  /\bunder load\b/i,
  /\btraffic spike\b/i,
  /\boutage\b/i,
  /\bfail[- ]?over\b/i,
  /\bscal(e|es|ing|ability)\b.*\busers?\b/i,
  /\bin production\b/i,
  /\breal users\b/i,
  /\bdowntime\b/i,
];

export function isRuntimeQuestion(question: string): boolean {
  const q = question || "";
  return RUNTIME_PATTERNS.some((p) => p.test(q));
}

/** The four starter pills: answered deterministically from the report —
 *  no model call, no charge, and they can never decline. A model asked
 *  "what's the biggest risk?" can talk itself into declining; the report
 *  already knows the answer, so we don't ask. */
export function starterAnswer(
  question: string,
  report: FinalReadReport
): { answer: string; citedFindings: string[] } | null {
  const q = (question || "").trim().toLowerCase().replace(/\?+$/, "");
  const sevRank = (s: string) =>
    ({ critical: 0, high: 1, medium: 2 }[(s || "").toLowerCase()] ?? 3);
  const bySeverity = [...report.liabilities].sort(
    (a, b) => sevRank(a.severity) - sevRank(b.severity)
  );

  if (q === "is this app actually finished") {
    return {
      answer:
        `${report.verdict} The review scored completeness ` +
        `${report.completenessScore}/100.`,
      citedFindings: [],
    };
  }

  if (q === "what's the biggest risk" || q === "what is the biggest risk") {
    const top = bySeverity[0];
    if (!top) {
      const hb = report.halfBuilt[0];
      return {
        answer: hb
          ? `The review found no liabilities. The biggest open area is ${hb.title}: ${hb.businessImplication}`
          : "The review found no liabilities or half-built areas.",
        citedFindings: hb ? [hb.title] : [],
      };
    }
    return {
      answer: `The biggest risk is ${top.title}: ${top.businessImplication}`,
      citedFindings: [top.title],
    };
  }

  if (q === "is the login and authentication real") {
    const auth = [...report.liabilities, ...report.halfBuilt, ...report.working].find(
      (i) => /authentication/i.test(i.title)
    );
    if (!auth) {
      return {
        answer: "The review did not assess authentication.",
        citedFindings: [],
      };
    }
    return {
      answer: `Authentication: ${auth.businessImplication}`,
      citedFindings: [auth.title],
    };
  }

  if (q === "what should be fixed first") {
    const ordered = bySeverity.slice(0, 3);
    if (ordered.length === 0) {
      return {
        answer: "The review found no liabilities to fix.",
        citedFindings: [],
      };
    }
    return {
      answer:
        "Fix in this order: " +
        ordered
          .map((l, i) => `${i + 1}. ${l.title} — ${l.businessImplication}`)
          .join(" "),
      citedFindings: ordered.map((l) => l.title),
    };
  }

  // Verification items get their own deterministic path: listed as
  // flagged, never as established facts, and never counted as liabilities.
  if (q === "what still needs verifying" || q === "what still needs verification") {
    if (report.needsVerification.length === 0) {
      return {
        answer:
          "The review flagged nothing for developer verification — every finding it reported was established from the code reviewed.",
        citedFindings: [],
      };
    }
    const n = report.needsVerification.length;
    return {
      answer:
        `The review flagged ${n} ${n === 1 ? "item" : "items"} for developer verification. ` +
        `Flagged, not established — none counted as a liability until a developer confirms ${n === 1 ? "it" : "them"}: ` +
        report.needsVerification
          .map((it) => `${it.title} — ${it.verification ? it.verification.whatWeSaw : it.businessImplication}`)
          .join(" "),
      citedFindings: report.needsVerification.map((it) => it.title),
    };
  }

  return null;
}

/** A grounded answer must cite something the report actually contains.
 *  Returns the cited titles that do NOT match anything the report holds.
 *
 *  Matching rule (2026-10-25, warehouse-citation fix): a cited string
 *  passes when, after normalizing (trim, lowercase, collapsed whitespace,
 *  surrounding quotes and trailing :;, stripped), it matches one of:
 *  1. A finding title from liabilities / halfBuilt / working — the
 *     original behavior, unchanged.
 *  2. A warehouse identifier, exactly: the map entrypoint, a component
 *     name, a component or ledger file path, an endpoint path, or a
 *     "METHOD path" string. File basenames count when they carry an
 *     extension (factLedger.ts cites src/lib/factLedger.ts); a bare
 *     directory name does not.
 *  3. A trailing, segment-aligned suffix of a known file/endpoint path
 *     (lib/factLedger.ts for src/lib/factLedger.ts).
 *  4. A warehouse phrase: a cited string of at least two words that
 *     appears verbatim (normalized) inside ONE structured warehouse text
 *     field — an endpoint purpose, a ledger description or contribution,
 *     a component name, or a category reason. Matching is per-field,
 *     never against the concatenated context blob, so a phrase stitched
 *     across two unrelated lines cannot pass.
 *
 *  Deliberately still rejected: single generic words ("characters",
 *  "audio") — neither identifiers in the report nor multi-word phrases;
 *  invented strings and invented file paths; phrases that appear nowhere
 *  in the report. The reverse direction (a real field embedded inside a
 *  longer invented citation) is NOT accepted: a long invented citation
 *  that happens to contain a real short phrase must still fail. That is
 *  what keeps the check an anti-hallucination check now that the full
 *  warehouse is in Q&A context — the model may ground HOW answers in
 *  warehouse material, but only in warehouse material that is really
 *  there. Bucket-item evidence lines are not covered here; they are
 *  folded into the items' business implications, and a citation to a
 *  verbatim evidence line still fails (follow-up if that ever bites). */
export function unknownCitations(citedTitles: string[], report: FinalReadReport): string[] {
  const norm = (s: string): string =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^["']+|["']+$/g, "")
      .replace(/[:;,]+$/g, "")
      .trim();
  const basename = (p: string): string => {
    const parts = String(p || "").split("/");
    return parts[parts.length - 1] || "";
  };

  const titles = new Set<string>();
  for (const item of [
    ...report.liabilities,
    ...report.halfBuilt,
    ...report.working,
    ...report.needsVerification,
  ]) {
    const n = norm(item.title);
    if (n) titles.add(n);
  }

  const identifiers = new Set<string>();
  const paths: string[] = [];
  const fields: string[] = [];
  const addPath = (p: string | undefined): void => {
    const n = norm(p || "");
    if (!n) return;
    identifiers.add(n);
    paths.push(n);
    const base = norm(basename(p || ""));
    if (base.includes(".")) identifiers.add(base);
  };

  const map = report.applicationMap;
  if (map) {
    addPath(map.entrypoint);
    for (const c of map.components || []) {
      const name = norm(c.name);
      if (name) {
        identifiers.add(name);
        fields.push(name);
      }
      addPath(c.filePath);
    }
    for (const e of map.endpoints || []) {
      addPath(e.path);
      const methodPath = norm(`${e.method || ""} ${e.path || ""}`);
      if (methodPath) identifiers.add(methodPath);
      const purpose = norm(e.purpose || "");
      if (purpose) fields.push(purpose);
    }
  }
  for (const e of report.fileLedger || []) {
    addPath(e.filePath);
    const description = norm(e.description || "");
    if (description) fields.push(description);
    const contribution = norm(e.contribution || "");
    if (contribution) fields.push(contribution);
  }
  const reasons = report.categoryReasons;
  if (reasons) {
    for (const key of Object.keys(reasons)) {
      const reason = norm(reasons[key]);
      if (reason) fields.push(reason);
    }
  }

  const unknown: string[] = [];
  for (const t of citedTitles || []) {
    const n = norm(t);
    if (!n) continue;
    if (titles.has(n) || identifiers.has(n)) continue;
    if (
      n.includes("/") &&
      paths.some((p) => p === n || p.endsWith(`/${n}`))
    ) {
      continue;
    }
    if (n.split(" ").length >= 2 && fields.some((f) => f.includes(n))) {
      continue;
    }
    unknown.push(String(t).trim());
  }
  return unknown;
}

/** Tiered declines (from the resilience dimension brief):
 *  - "partial": the review flags the area but lacks the specific detail.
 *    Never a flat "I don't know" — say what WAS established instead.
 *  - "runtime": the question needs live runtime observation to answer.
 *  - "unknown": nothing in the review bears on the question (the old flat
 *    decline). */
export type DeclineTier = "partial" | "runtime" | "unknown";

export function normalizeDeclineTier(value: unknown): DeclineTier {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "partial" || v === "runtime" || v === "unknown") return v;
  return "unknown";
}

/** Tier-2 decline framing: prefixed (server-side) to a model answer that is
 *  still grounded in cited findings — it names what the review DID establish
 *  instead of flat-declining. Charged like a grounded answer. */
export const PARTIAL_DECLINE_PREFIX =
  "The review didn't analyze that specifically. What it did establish: ";

/** Tier-3 decline: fixed server-side reply, no model wording, no charge.
 *  The review reads code; it never executes it. */
export const RUNTIME_DECLINE_REPLY =
  "That needs the app actually running to answer — real traffic, real data, real failures. " +
  "This review reads the code; it never executes it. What would answer it: run it under load, " +
  "crash-test it, or watch it in production for a while.";

/** Flat unknown-tier decline: free, no model call is charged for it. */
export const FLAT_DECLINE_REPLY =
  "That question can't be answered from this review without guessing, so I won't guess. " +
  "It covers what the scan found — ask about the verdict, the liabilities, or what's half-built.";

/** Uncited-fallback decline: the model answered but cited findings the
 *  report doesn't contain, so the answer is discarded. Free. */
export const UNCITED_DECLINE_REPLY =
  "I can't answer that from what's in this review without guessing, so I won't. " +
  "Try asking about the verdict, the liabilities, or a specific half-built area.";

/** Free-decline rephrase note (exact wording, founder-approved 2026-10-25):
 *  appended server-side to unknown-tier and uncited-fallback declines
 *  ONLY. Never on partials (charged like answers), runtime replies,
 *  estimate replies, or grounded answers — the "no credit was charged"
 *  claim is only true on the free paths. */
export const FREE_DECLINE_REPHRASE_NOTE =
  "This question wasn't answered, so no credit was charged. Rephrasing sometimes finds it — try describing what you're asking about in plain words, rather than using a product or feature name.";

/** Double-checked marking: prefixed to an unknown-tier decline only when a
 *  second model also reviewed the full review and found nothing on the
 *  question. Never attached when the verification call failed or couldn't
 *  run — the check did not complete, so claiming it would be dishonest. */
export const DOUBLE_CHECKED_DECLINE_PREFIX =
  "Checked twice against the full review — a second model also found nothing on this: ";

/** Full unknown-tier decline text, with the rephrase note. */
export function formatUnknownDecline(doubleChecked: boolean): string {
  const base = doubleChecked
    ? DOUBLE_CHECKED_DECLINE_PREFIX + FLAT_DECLINE_REPLY
    : FLAT_DECLINE_REPLY;
  return `${base} ${FREE_DECLINE_REPHRASE_NOTE}`;
}

/** Full uncited-fallback decline text, with the rephrase note. */
export function formatUncitedDecline(): string {
  return `${UNCITED_DECLINE_REPLY} ${FREE_DECLINE_REPHRASE_NOTE}`;
}

/** Which model verifies an unknown-tier decline: always the OTHER model in
 *  the premium chain (Gemini primary ↔ Claude Sonnet), never the same
 *  model twice and never the consumer lite model. Returns null when the
 *  other model is unavailable (Claude unconfigured and the first model was
 *  Gemini) — the caller then keeps the original decline, unmarked. */
export function pickVerificationModel(
  firstWasClaude: boolean,
  claudeConfigured: boolean
): "gemini" | "claude" | null {
  if (firstWasClaude) return "gemini";
  return claudeConfigured ? "claude" : null;
}

/** Verification prompt for the double-check call: the verifier re-reads the
 *  same review and must expand the question's terms BOTH ways before
 *  concluding absence — the review often names a thing differently from
 *  the question, in either direction. Examples are load-bearing: each pair
 *  is a real dogfood miss from 2026-10-24 (codex, SpeechSynthesis, and the
 *  stateless proxy all declined or mis-answered on their first ask). */
export function doubleCheckPrompt(context: string, question: string): string {
  return (
    `You are verifying a first model's decline for a non-technical decision maker. ` +
    `The first model said nothing in the review bears on the question. Before you agree, ` +
    `expand the question's terms BOTH ways and search the whole review again — the review ` +
    `often names a thing differently from the question:\n` +
    `- product/internal names ↔ plain descriptions (for example, "codex" ↔ fact ledger, character roles, continuity features)\n` +
    `- technical API names ↔ plain descriptions (for example, "SpeechSynthesis" ↔ native browser speech, free OS voices)\n` +
    `- architecture wording ↔ the property asked about (for example, "stateless proxy" ↔ whether keys are stored)\n` +
    `Answer in plain English, as the first model was asked to. If any part of the review ` +
    `establishes any part of an answer, answer it grounded in cited findings (or use the ` +
    `partial tier if only part is established) — do not repeat the decline. Only decline ` +
    `as unknown if, after expanding terms both ways, truly nothing in the review bears on the question.\n\n` +
    `HARD RULES:\n` +
    `- Answer ONLY from the review below. Cite exact finding titles in citedFindings.\n` +
    `- NEVER invent findings, files, or numbers not in the review.\n` +
    `- NEVER give cost, time, or effort estimates.\n\n` +
    `THE REVIEW:\n${context}\n\nQUESTION: ${(question || "").trim()}`
  );
}

/** Partial-tier scoping guardrail: a partial answer may only speak for the
 *  material surfaced for the question. Gaps are scoped to that material,
 *  never asserted about the whole review — the Q&A context is a budgeted
 *  slice, so absence from the slice is not absence from the review. (A
 *  charged partial once asserted "the review does not detail" native
 *  browser speech while the full review's ledger detailed SpeechSynthesis
 *  in the player — the serious shape of this bug.) */
export const PARTIAL_SCOPE_GUIDANCE =
  "When the review establishes only part of an answer, lead with what WAS established from cited findings, " +
  "and scope any gap to the material surfaced for this question — say 'not found in the material surfaced for this question'. " +
  "Never assert a gap about the whole review ('the review does not detail', 'the review does not cover', 'the review contains no analysis'): " +
  "the context you were given is a slice of the review, so absence from it is not absence from the review.";

/** Warehouse runaway ceiling: the deep sections appended after the headline
 *  report (application map, category detail, file ledger) share one
 *  deterministic character ceiling so a pathological intelligence result
 *  can't blow up the prompt. Priority order: application map → category
 *  detail → file ledger. Truncation cuts at a line boundary, reserves room
 *  for the truncation note up front, and appends that note, so the
 *  warehouse portion never exceeds the ceiling — and never truncates
 *  silently.
 *
 *  Founder cost policy (2026-10-25, investor version only): up to ~$10 of
 *  API cost per run is acceptable at the $199 margin, so cost is NOT a
 *  reason to truncate investor Q&A context — if evidence is in the
 *  GradeVibes analysis it must be reachable here. This ceiling is a
 *  runaway guard, not a cost optimizer.
 *
 *  Token math for the value: at ~4 chars/token, 500,000 chars is ~125,000
 *  input tokens — inside a Sonnet-class ~200,000-token window with room
 *  for the headline context and the answer, and at even $15 per million
 *  input tokens a full-ceiling prompt costs ~$1.90 of input, so a first
 *  call plus one double-check verification call stays well under the ~$10
 *  tolerance. A 72-file warehouse runs ~30–40,000 chars, so ordinary
 *  reviews pass through whole; only multi-thousand-file dumps hit the
 *  ceiling. Consumer cost discipline is unchanged — the consumer tier has
 *  no Q&A, and this constant is only read on the FinalRead ask path. */
export const WAREHOUSE_CONTEXT_BUDGET = 500000;

const WAREHOUSE_TRUNCATION_NOTE =
  "(warehouse detail truncated for size — the full review holds more than fits here)";

function buildWarehouseSections(report: FinalReadReport): string[][] {
  const sections: string[][] = [];

  const map = report.applicationMap;
  if (map) {
    const lines: string[] = [];
    if (map.entrypoint) lines.push(`- entrypoint: ${map.entrypoint}`);
    for (const c of map.components || []) {
      const imports =
        c.imports && c.imports.length > 0 ? ` — imports: ${c.imports.join(", ")}` : "";
      lines.push(`- component: ${c.name}${c.filePath ? ` (${c.filePath})` : ""}${imports}`);
    }
    for (const e of map.endpoints || []) {
      lines.push(`- endpoint: ${e.method} ${e.path}${e.purpose ? ` — ${e.purpose}` : ""}`);
    }
    if (lines.length > 0) sections.push(["APPLICATION MAP:", ...lines]);
  }

  const reasons = report.categoryReasons;
  if (reasons && Object.keys(reasons).length > 0) {
    const lines = Object.keys(reasons).map((key) => `- ${key}: ${reasons[key]}`);
    sections.push(["CATEGORY DETAIL:", ...lines]);
  }

  const ledger = report.fileLedger;
  if (ledger && ledger.length > 0) {
    const lines = ledger.map((e) => {
      const bits = [e.filePath];
      if (e.lineCount != null) bits.push(`${e.lineCount} lines`);
      if (e.description) bits.push(e.description);
      if (e.contribution) bits.push(`contributes: ${e.contribution}`);
      return `- ${bits.join(" — ")}`;
    });
    sections.push(["FILE LEDGER:", ...lines]);
  }

  return sections;
}

/** Words too generic to discriminate warehouse lines. Question verbs and
 *  the words "app"/"review" appear in nearly every line, so keeping them
 *  would admit the whole warehouse as "matching" and defeat retention. */
const QUESTION_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "was", "were", "be", "been", "does", "do", "did", "what", "how", "why",
  "when", "where", "which", "who", "whom", "this", "that", "these",
  "those", "it", "its", "by", "with", "from", "about", "any", "can",
  "could", "should", "would", "will", "shall", "there", "here", "your",
  "you", "yours", "we", "our", "they", "their", "he", "she", "his", "her",
  "my", "me", "i", "am", "as", "at", "if", "so", "than", "then", "not",
  "no", "yes", "per", "via", "into", "over", "under", "after", "before",
  "between", "app", "apps", "review", "question", "tell", "give", "show",
  "list", "describe", "explain",
]);

/** Discriminating terms from a stakeholder question: lowercased, split on
 *  non-alphanumerics, stopwords and tokens shorter than 3 chars dropped,
 *  de-duplicated in first-seen order. */
export function questionTerms(question: string): string[] {
  const seen = new Set<string>();
  for (const raw of (question || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 3 || QUESTION_STOPWORDS.has(raw)) continue;
    if (!seen.has(raw)) seen.add(raw);
  }
  return [...seen];
}

/** Cheap plural/singular variants only — no stemmer. "keys" matches "key"
 *  and vice versa; anything fancier would need a real tokenizer. */
function termVariants(term: string): string[] {
  if (term.endsWith("s") && term.length > 3) return [term, term.slice(0, -1)];
  if (!term.endsWith("s")) return [term, `${term}s`];
  return [term];
}

/** Case-insensitive substring match of a warehouse line against any
 *  question term (or its plural/singular variant). */
export function warehouseLineMatches(line: string, terms: string[]): boolean {
  const lower = (line || "").toLowerCase();
  return terms.some((t) => termVariants(t).some((v) => lower.includes(v)));
}

/** Admit warehouse lines under a character budget, with query-aware
 *  retention as the fallback beyond the ceiling: when a question is
 *  supplied, question-matching lines are admitted FIRST (in original
 *  priority order — map → reasons → ledger), then the remaining lines in
 *  original priority order. Matching lines are prioritized WITHIN the
 *  ceiling, not exempt from it: beyond the ceiling everything still cuts
 *  at a line boundary with the truncation note appended. With no question
 *  (or no discriminating terms) the order is exactly the old one. Section
 *  headers travel with their sections: a header is emitted once, ahead of
 *  its first admitted line in either pass. */
export function selectWarehouseLines(
  report: FinalReadReport,
  question?: string,
  budget: number = WAREHOUSE_CONTEXT_BUDGET
): string[] {
  const sections = buildWarehouseSections(report);
  const terms = question ? questionTerms(question) : [];
  let ordered: string[];
  if (terms.length === 0) {
    ordered = sections.flat();
  } else {
    const first: string[] = [];
    const rest: string[] = [];
    for (const section of sections) {
      const [header, ...lines] = section;
      const matching = lines.filter((l) => warehouseLineMatches(l, terms));
      const others = lines.filter((l) => !warehouseLineMatches(l, terms));
      if (matching.length > 0) first.push(header, ...matching);
      if (others.length > 0) rest.push(header, ...others);
    }
    ordered = [...first, ...rest];
  }
  const contentBudget = budget - (WAREHOUSE_TRUNCATION_NOTE.length + 1);
  const out: string[] = [];
  let used = 0;
  let truncated = false;
  for (const line of ordered) {
    const cost = line.length + 1; // the joining newline
    if (used + cost > contentBudget) {
      truncated = true;
      break;
    }
    out.push(line);
    used += cost;
  }
  if (truncated) out.push(WAREHOUSE_TRUNCATION_NOTE);
  return out;
}

/** Compact, citable context for the model prompt: verdict, bucket titles,
 *  and the liability details, followed by the warehouse sections — the
 *  deep analysis (application map, the assessor's raw category reasons,
 *  the per-file ledger) the stakeholder UI never displays. The warehouse
 *  rides along so "how is X handled" questions can retrieve what the
 *  intelligence run established instead of declining from the thin bucket
 *  context alone. Category items carry condensed deterministic scan
 *  evidence so "which?" questions have specifics to stand on — the prompt
 *  tells the model to use the anchors for precision but never quote raw
 *  file paths to the stakeholder. Still excludes code and file contents. */
export function buildQaContext(report: FinalReadReport, question?: string): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${report.projectTitle}`);
  if (report.applicationSummary) {
    lines.push(`WHAT THIS APP IS: ${report.applicationSummary}`);
  }
  lines.push(`COMPLETENESS: ${report.completenessScore}/100`);
  lines.push(`VERDICT: ${report.verdict}`);
  const section = (
    name: string,
    items: {
      title: string;
      businessImplication: string;
      file: string;
      line: number | null;
      evidence?: string[];
    }[]
  ) => {
    lines.push(`${name.toUpperCase()} (${items.length}):`);
    for (const it of items) {
      const loc = it.file ? ` [${it.file}${it.line != null ? ":" + it.line : ""}]` : "";
      lines.push(`- ${it.title}${loc}: ${it.businessImplication}`);
      if (it.evidence && it.evidence.length > 0) {
        lines.push(`  scan evidence: ${it.evidence.join(" | ")}`);
      }
    }
  };
  section("liabilities", report.liabilities);
  // Verification items sit right after liabilities: visible, but never
  // mistaken for them. The header line states the flagged-not-established
  // status up front so the model cannot read the items below as findings.
  if (report.needsVerification.length > 0) {
    lines.push(`NEEDS VERIFICATION (${report.needsVerification.length}):`);
    lines.push(
      `These items were flagged by the scan but NOT established — the review could not verify them from the code. Never present one as an established fact or a liability.`
    );
    for (const it of report.needsVerification) {
      const loc = it.file ? ` [${it.file}${it.line != null ? ":" + it.line : ""}]` : "";
      lines.push(`- ${it.title}${loc}: ${it.businessImplication}`);
      if (it.verification) {
        lines.push(`  what the scan saw: ${it.verification.whatWeSaw}`);
        lines.push(`  if confirmed: ${it.verification.ifReal}`);
        lines.push(`  how a developer checks it: ${it.verification.howToCheck}`);
      }
    }
  }
  section("half-built", report.halfBuilt);
  section("working", report.working);
  lines.push("COULD NOT ESTABLISH:");
  for (const c of report.couldNotEstablish) lines.push(`- ${c}`);

  // Warehouse sections, under the runaway ceiling, with query-aware
  // retention when the question is supplied. No warehouse data → no lines
  // at all (no empty headers), so the context is exactly what it was
  // before the warehouse existed.
  const warehouse = selectWarehouseLines(report, question);
  if (warehouse.length > 0) {
    lines.push(...warehouse);
  }
  return lines.join("\n");
}
