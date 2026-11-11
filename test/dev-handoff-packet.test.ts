// Multi-finding handoff packet renderer (schema v1.1).
import { describe, it, expect } from "vitest";
import {
  renderMultiFindingPacket,
  renderDevHandoffPacket,
  type DevHandoffFinding,
  type SuggestedFix,
} from "../shared/dev-handoff-packet";

const findingA: DevHandoffFinding = {
  title: "Hardcoded secret",
  message: "API key in source",
  severity: "high",
  type: "secrets",
  file: "src/config.ts",
  line: 12,
  suggestion: "Move to env vars.",
};

const findingB: DevHandoffFinding = {
  title: "Missing auth",
  message: "Route has no auth",
  severity: "critical",
  type: "auth",
  file: "src/routes.ts",
  line: 40,
};

const fixA: SuggestedFix = {
  plainEnglishIssue: "Anyone reading the code gets the key.",
  evidence: "src/config.ts:12\nconst KEY = 'abc'",
  remediationDiff: "-const KEY='abc'\n+const KEY=process.env.KEY",
  verificationSteps: ["Rotate the key", "Re-run the scan"],
};

describe("renderMultiFindingPacket", () => {
  it("renders one numbered section per finding", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: findingA, fix: fixA }, { finding: findingB }],
      includedCount: 2,
      totalCount: 5,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).toContain("## Finding 1: Hardcoded secret");
    expect(md).toContain("## Finding 2: Missing auth");
    expect(md).toContain("**Findings included:** 2 of 5");
    expect(md).toContain("**Product:** FinalRead");
  });

  it("emits the disclaimers exactly once", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: findingA, fix: fixA }, { finding: findingB }],
      includedCount: 2,
      totalCount: 2,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md.match(/## Runtime disclaimer/g)!.length).toBe(1);
    expect(md.match(/## Scope notice/g)!.length).toBe(1);
    expect(md).toContain("covers 2 findings");
  });

  it("falls back to scanner wording when no AI fix exists, without inventing", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: findingB }],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).toContain("No AI suggestion was generated for this finding");
    expect(md).toContain("src/routes.ts:40");
  });

  it("leaves the single-finding renderer output unchanged", () => {
    const md = renderDevHandoffPacket({
      product: "GradeVibes",
      finding: findingA,
      fix: fixA,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).toContain("# Developer handoff — suggested fix (REVIEW ONLY)");
    expect(md).toContain("## Finding\n\nHardcoded secret");
    expect(md).toContain("one finding only");
    expect(md).not.toContain("## Finding 1:");
  });
});

describe("category-level items (spec §B)", () => {
  const categoryFinding: DevHandoffFinding = {
    title: "Background automation",
    message: "Half-built (3/10): scheduled jobs and background work is partly there but not complete.",
    severity: "high",
    type: "FinalRead liability",
    file: "",
    line: null,
  };
  const coreLogicFinding: DevHandoffFinding = {
    title: "Core logic",
    message: "Half-built (5/10): the main features the app promises to do is partly there but not complete.",
    severity: "medium",
    type: "FinalRead half-built",
    file: "",
    line: null,
  };
  const automationChecklist = [
    "Scheduled jobs",
    "Job queues",
    "Background workers",
    "Webhook retry/reconciliation logic",
  ];

  it("renders the B1 statement for an empty-file finding, never empty backticks", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: categoryFinding }],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).toContain("Category-level finding: no single file or line");
    expect(md).not.toContain("``");
  });

  it("points at the checklist when one exists, and at the evidence and checks otherwise (B2)", () => {
    const withChecklist = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: categoryFinding, checklist: automationChecklist }],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(withChecklist).toContain("Category-level finding. See the checklist below.");
    const withoutChecklist = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: coreLogicFinding }],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(withoutChecklist).toContain(
      "Category-level finding — no single fix applies; see the evidence and checks below."
    );
  });

  it("keeps the old wording for a file-level finding with no fix", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: findingB }],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).toContain("No AI suggestion was generated for this finding");
    expect(md).toContain("`src/routes.ts:40`");
  });

  it("renders the Background automation checklist's four items (B3)", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [
        {
          finding: categoryFinding,
          checklist: automationChecklist,
          evidenceLines: ["index.html:15 references automation/webhooks with no implementation"],
          howToCheck: "Work through the checklist below.",
        },
      ],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).toContain("### Checklist");
    for (const item of automationChecklist) {
      expect(md).toContain(`- [ ] ${item}`);
    }
    expect(md).toContain("- index.html:15 references automation/webhooks with no implementation");
    expect(md).toContain("### How a developer checks it");
    expect(md).toContain("Work through the checklist below.");
  });

  it("renders no checklist section when none is present (B4: no Core logic checklist)", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [
        {
          finding: coreLogicFinding,
          evidenceLines: [
            "75/75 logic-purporting non-test files contain real logic and are free of stub markers",
            "No stubs found.",
          ],
          howToCheck: "Reproduce the computation from the evidence above.",
        },
      ],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).not.toContain("### Checklist");
    expect(md).toContain("No stubs found.");
    expect(md).toContain("75/75 logic-purporting non-test files contain real logic");
  });

  it("carries the scanner and metric versions in the header (B6)", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: findingB }],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
      scannerVersion: "1",
      metricVersion: "2",
    });
    expect(md).toContain("**Scanner version:** v1");
    expect(md).toContain("**Core-logic metric version:** v2");
  });

  it("omits the version lines for older reports that carry none", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: findingB }],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).not.toContain("Scanner version");
    expect(md).not.toContain("metric version");
  });

  it("keeps the precise terms in the packet (B9)", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [
        {
          finding: coreLogicFinding,
          evidenceLines: ["1 fake-success findings — Core logic capped at 7: server.ts:124 (fabricated status)"],
        },
      ],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).toContain("fake-success findings");
    expect(md).toContain("server.ts:124 (fabricated status)");
  });

  it("still renders a liability item's anchor and scanner remediation exactly as before", () => {
    const md = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: findingA, fix: fixA }],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(md).toContain("`src/config.ts:12`");
    expect(md).toContain("Move to env vars.");
    const noFix = renderMultiFindingPacket({
      product: "FinalRead",
      items: [{ finding: findingA }],
      includedCount: 1,
      totalCount: 1,
      generatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(noFix).toContain("`src/config.ts:12`");
    expect(noFix).toContain("Scanner's recommendation (not AI-reviewed):\n\nMove to env vars.");
  });
});
