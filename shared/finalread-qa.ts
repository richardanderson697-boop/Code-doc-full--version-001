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

  return null;
}

/** A grounded answer must cite real finding titles from the report. Returns
 *  the cited titles that do NOT match anything the report contains. */
export function unknownCitations(citedTitles: string[], report: FinalReadReport): string[] {
  const known = new Set<string>();
  for (const item of [...report.liabilities, ...report.halfBuilt, ...report.working]) {
    known.add(item.title.trim().toLowerCase());
  }
  const unknown: string[] = [];
  for (const t of citedTitles || []) {
    const norm = String(t || "").trim().toLowerCase();
    if (norm && !known.has(norm)) unknown.push(String(t).trim());
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

/** Warehouse budget: the deep sections appended after the headline report
 *  (application map, category detail, file ledger) share one deterministic
 *  character budget so a large intelligence result can't blow up the
 *  prompt — or the premium fallback chain's token guard. Priority order:
 *  application map → category detail → file ledger. Truncation cuts at a
 *  line boundary, reserves room for the truncation note up front, and
 *  appends that note, so the warehouse portion never exceeds the budget. */
export const WAREHOUSE_CONTEXT_BUDGET = 24000;

const WAREHOUSE_TRUNCATION_NOTE =
  "(warehouse detail truncated for size — the full review holds more than fits here)";

function buildWarehouseLines(report: FinalReadReport): string[] {
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

  return sections.flat();
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
export function buildQaContext(report: FinalReadReport): string {
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
  section("half-built", report.halfBuilt);
  section("working", report.working);
  lines.push("COULD NOT ESTABLISH:");
  for (const c of report.couldNotEstablish) lines.push(`- ${c}`);

  // Warehouse sections, under the shared budget. No warehouse data → no
  // lines at all (no empty headers), so the context is exactly what it
  // was before the warehouse existed.
  const warehouse = buildWarehouseLines(report);
  if (warehouse.length > 0) {
    const contentBudget =
      WAREHOUSE_CONTEXT_BUDGET - (WAREHOUSE_TRUNCATION_NOTE.length + 1);
    let used = 0;
    let truncated = false;
    for (const line of warehouse) {
      const cost = line.length + 1; // the joining newline
      if (used + cost > contentBudget) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += cost;
    }
    if (truncated) lines.push(WAREHOUSE_TRUNCATION_NOTE);
  }
  return lines.join("\n");
}
