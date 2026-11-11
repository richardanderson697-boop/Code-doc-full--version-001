// Developer handoff packet (schema v1): the portable Markdown format both
// GradeVibes and FinalRead emit for a SUGGESTED fix to one audit finding.
// Shared between server, client, and tests so the packet contract has one
// definition. See docs/dev-handoff-packet-schema.md for the full spec.
//
// Design rules baked in here: the packet is review-only (nothing is applied),
// it carries a runtime disclaimer and a "not exhaustive" notice, and v1
// packets never contain effort estimates.

export interface DevHandoffFinding {
  title: string;
  message: string;
  severity: string;
  type: string;
  file: string;
  line: number | null;
  /** The scanner's own short recommendation, when one exists. */
  suggestion?: string;
}

export interface SuggestedFix {
  plainEnglishIssue: string;
  /** file:line reference plus the problem snippet, as the model wrote it. */
  evidence: string;
  /** Unified diff or labeled BEFORE/AFTER blocks showing the suggested change. */
  remediationDiff: string;
  verificationSteps: string[];
}

export interface DevHandoffPacketInput {
  /** "GradeVibes" or "FinalRead". */
  product: string;
  finding: DevHandoffFinding;
  fix: SuggestedFix;
  /** ISO 8601 timestamp. */
  generatedAt: string;
}

/** Wrap content in a fenced block whose fence is one backtick longer than the
 *  longest backtick run inside the content. Model-emitted fences (e.g. an
 *  evidence snippet that arrives as "File: x\n```ts\ncode\n```") can therefore
 *  never break the packet's own blocks, and the content is preserved exactly
 *  instead of being stripped. */
function fenceBlock(content: string, info: string): string {
  const text = String(content ?? "").trim();
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [info ? fence + info : fence, text, fence].join("\n");
}

function lineAnchor(file: string, line: number | null): string {
  return line != null ? `${file}:${line}` : file;
}

/** One item in a multi-finding packet. `fix` is the AI-generated suggestion
 *  when one exists; when absent, the section falls back to the scanner's own
 *  wording (title/message/remediation) with an explicit notice — nothing is
 *  invented to fill the gap. Category-level items (no single file or line)
 *  carry their evidence lines, checklist, and how-to-check instead. */
export interface MultiFindingItem {
  finding: DevHandoffFinding;
  fix?: SuggestedFix;
  /** Deterministic evidence lines (category items only). */
  evidenceLines?: string[];
  /** Missing pieces to check off (background automation only). */
  checklist?: string[];
  /** How a developer checks the item (category items only). */
  howToCheck?: string;
}

export interface MultiFindingPacketInput {
  /** "GradeVibes" or "FinalRead". */
  product: string;
  items: MultiFindingItem[];
  /** Findings included in this packet. */
  includedCount: number;
  /** Findings in the report the selection came from. */
  totalCount: number;
  /** ISO 8601 timestamp. */
  generatedAt: string;
  /** Scanner version and Core-logic metric version that produced the
   *  report (from the deterministic scorer). Rendered in the header
   *  when present; omitted for older reports that carry none. */
  scannerVersion?: string;
  metricVersion?: string;
}

function versionLabel(v: string): string {
  return v.startsWith("v") ? v : `v${v}`;
}

function renderMultiFindingSection(item: MultiFindingItem, index: number): string[] {
  const { finding, fix } = item;
  // Category-level findings carry no file — never render empty backticks
  // for the anchor (§B1). A finding with a file keeps the anchor.
  const hasFile = finding.file.trim().length > 0;
  const anchor = lineAnchor(finding.file, finding.line);
  const evidenceLines = (item.evidenceLines || []).filter((l) => l.trim().length > 0);
  const lines: string[] = [
    `## Finding ${index}: ${finding.title}`,
    ``,
    `### Source finding`,
    ``,
    `- **Message:** ${finding.message}`,
    `- **Severity:** ${finding.severity}`,
    `- **Type:** ${finding.type}`,
    ...(finding.suggestion ? [`- **Scanner recommendation:** ${finding.suggestion}`] : []),
    ``,
  ];
  if (fix) {
    const steps =
      fix.verificationSteps.length > 0
        ? fix.verificationSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")
        : "1. (No verification steps were provided — confirm the change manually before shipping.)";
    lines.push(
      `### Plain-English issue`,
      ``,
      fix.plainEnglishIssue,
      ``,
      `### Evidence`,
      ``,
      `\`${anchor}\``,
      ``,
      fenceBlock(fix.evidence, ""),
      ``,
      `### Suggested remediation`,
      ``,
      `The diff below is a suggestion only — it has not been applied to your code.`,
      ``,
      fenceBlock(fix.remediationDiff, "diff"),
      ``,
      `### How to verify the fix`,
      ``,
      steps,
      ``
    );
  } else {
    // No AI suggestion: the notice is conditional (§B2). A checklist
    // points at itself; a category item without one points at the
    // evidence and checks; a file-level finding keeps the existing
    // wording — the scanner's own wording is shown as-is.
    const notice = item.checklist
      ? `Category-level finding. See the checklist below.`
      : !hasFile
        ? `Category-level finding — no single fix applies; see the evidence and checks below.`
        : `No AI suggestion was generated for this finding — the scanner's own wording is shown as-is.`;
    lines.push(
      `### Plain-English issue`,
      ``,
      notice,
      ``,
      `### Evidence`,
      ``,
      ...(hasFile
        ? [`\`${anchor}\``, ``]
        : [`Category-level finding: no single file or line`, ``]),
      ...(evidenceLines.length > 0
        ? [...evidenceLines.map((l) => `- ${l}`), ``]
        : []),
      ...(item.checklist
        ? [
            `### Checklist`,
            ``,
            ...item.checklist.map((c) => `- [ ] ${c}`),
            ``,
          ]
        : []),
      ...(item.howToCheck
        ? [`### How a developer checks it`, ``, item.howToCheck, ``]
        : []),
      `### Suggested remediation`,
      ``,
      finding.suggestion
        ? `Scanner's recommendation (not AI-reviewed):\n\n${finding.suggestion}`
        : `No remediation text available from the scanner.`,
      ``
    );
  }
  return lines;
}

/** Multi-finding packet (schema v1.1): one header, one self-contained section
 *  per finding, disclaimers once at the end. Exporting is free — it only
 *  renders suggestions that were already generated. */
export function renderMultiFindingPacket(input: MultiFindingPacketInput): string {
  const { product, items, includedCount, totalCount, generatedAt } = input;
  const lines: string[] = [
    `# Developer handoff — ${items.length} ${items.length === 1 ? "finding" : "findings"} (REVIEW ONLY)`,
    ``,
    `**Product:** ${product}`,
    `**Generated:** ${generatedAt}`,
    ...(input.scannerVersion ? [`**Scanner version:** ${versionLabel(input.scannerVersion)}`] : []),
    ...(input.metricVersion ? [`**Core-logic metric version:** ${versionLabel(input.metricVersion)}`] : []),
    `**Findings included:** ${includedCount} of ${totalCount}`,
    `**Status:** Suggested fixes — NOT applied. Human review required.`,
    ``,
  ];
  items.forEach((item, i) => {
    lines.push(...renderMultiFindingSection(item, i + 1));
  });
  lines.push(
    `## Runtime disclaimer`,
    ``,
    `These suggestions were generated from static analysis output. They were not executed, tested, or verified at runtime. Behavior in production may differ from what is described here.`,
    ``,
    `## Scope notice`,
    ``,
    `This packet is not exhaustive: it covers ${items.length} ${items.length === 1 ? "finding" : "findings"} and does not certify the codebase. Automated suggestions need human review before any change ships.`,
    ``,
    `*No effort estimates are included in v1 packets by design.*`,
    ``
  );
  return lines.join("\n");
}

export function renderDevHandoffPacket(input: DevHandoffPacketInput): string {
  const { product, finding, fix, generatedAt } = input;
  const anchor = lineAnchor(finding.file, finding.line);
  const steps =
    fix.verificationSteps.length > 0
      ? fix.verificationSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "1. (No verification steps were provided — confirm the change manually before shipping.)";

  return [
    `# Developer handoff — suggested fix (REVIEW ONLY)`,
    ``,
    `**Product:** ${product}`,
    `**Generated:** ${generatedAt}`,
    `**Status:** Suggested fix — NOT applied. Human review required.`,
    ``,
    `## Finding`,
    ``,
    finding.title,
    ``,
    `## Source finding`,
    ``,
    `- **Message:** ${finding.message}`,
    `- **Severity:** ${finding.severity}`,
    `- **Type:** ${finding.type}`,
    ...(finding.suggestion ? [`- **Scanner recommendation:** ${finding.suggestion}`] : []),
    ``,
    `## Plain-English issue`,
    ``,
    fix.plainEnglishIssue,
    ``,
    `## Evidence`,
    ``,
    `\`${anchor}\``,
    ``,
    fenceBlock(fix.evidence, ""),
    ``,
    `## Suggested remediation`,
    ``,
    `The diff below is a suggestion only — it has not been applied to your code.`,
    ``,
    fenceBlock(fix.remediationDiff, "diff"),
    ``,
    `## How to verify the fix`,
    ``,
    steps,
    ``,
    `## Runtime disclaimer`,
    ``,
    `This suggestion was generated by an AI model from static analysis output. It was not executed, tested, or verified at runtime. Behavior in production may differ from what is described here.`,
    ``,
    `## Scope notice`,
    ``,
    `This packet is not exhaustive: it covers one finding only and does not certify the codebase. It is an automated suggestion — a human developer must review and approve any change before it ships.`,
    ``,
    `*No effort estimates are included in v1 packets by design.*`,
    ``,
  ].join("\n");
}
