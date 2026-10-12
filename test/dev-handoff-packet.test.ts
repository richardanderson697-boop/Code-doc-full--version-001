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
