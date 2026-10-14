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

/** Compact, citable context for the model prompt: verdict, bucket titles,
 *  and the liability details. Deliberately excludes code, file contents,
 *  and anything the stakeholder UI never shows. */
export function buildQaContext(report: FinalReadReport): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${report.projectTitle}`);
  if (report.applicationSummary) {
    lines.push(`WHAT THIS APP IS: ${report.applicationSummary}`);
  }
  lines.push(`COMPLETENESS: ${report.completenessScore}/100`);
  lines.push(`VERDICT: ${report.verdict}`);
  const section = (name: string, items: { title: string; businessImplication: string; file: string; line: number | null }[]) => {
    lines.push(`${name.toUpperCase()} (${items.length}):`);
    for (const it of items) {
      const loc = it.file ? ` [${it.file}${it.line != null ? ":" + it.line : ""}]` : "";
      lines.push(`- ${it.title}${loc}: ${it.businessImplication}`);
    }
  };
  section("liabilities", report.liabilities);
  section("half-built", report.halfBuilt);
  section("working", report.working);
  lines.push("COULD NOT ESTABLISH:");
  for (const c of report.couldNotEstablish) lines.push(`- ${c}`);
  return lines.join("\n");
}
