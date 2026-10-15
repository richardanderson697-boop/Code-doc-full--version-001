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

/** Compact, citable context for the model prompt: verdict, bucket titles,
 *  and the liability details. Deliberately excludes code, file contents,
 *  and anything the stakeholder UI never shows. Category items carry
 *  condensed deterministic scan evidence so "which?" questions have
 *  specifics to stand on — the prompt tells the model to use the anchors
 *  for precision but never quote raw file paths to the stakeholder. */
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
  return lines.join("\n");
}
