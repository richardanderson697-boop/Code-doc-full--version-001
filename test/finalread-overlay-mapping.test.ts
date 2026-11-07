// intelResultToFinalReadInput: deterministic findings from the intelligence
// run ride into the audit input's findings (same bucketing as PreFlight).
import { describe, it, expect } from "vitest";
import { intelResultToFinalReadInput } from "../src/components/auditor/FinalReadOverlay";

describe("intelResultToFinalReadInput deterministic findings", () => {
  it("appends deterministic findings after PreFlight findings", () => {
    const audit = intelResultToFinalReadInput({
      completenessScore: 72,
      categoryScores: {},
      missingFeatures: [],
      preflight: {
        findings: [
          { severity: "high", title: "Hardcoded secret", file: "src/config.ts", line: 12, probe: "secrets" },
        ],
        failed: null,
        probeFailures: [],
        filesSkipped: [],
        filesScanned: 40,
      },
      deterministicAssessment: {
        findings: [
          {
            severity: "high",
            title: 'Dead "Get Started" button',
            file: "app/pricing/pricing-client.tsx",
            line: 14,
            probe: "Dead Action",
            remediation: "Wire it up.",
          },
          {
            severity: "medium",
            title: "Checkout records sales as complete with no payment provider call",
            file: "app/api/checkout/route.ts",
            line: 31,
            probe: "Mocked Payment",
            unverified: true,
          },
        ],
      },
    });
    expect(audit.findings).toHaveLength(3);
    expect(audit.findings[0].title).toBe("Hardcoded secret");
    expect(audit.findings[1].title).toMatch(/Get Started/);
    expect(audit.findings[2].unverified).toBe(true);
  });

  it("drops junk deterministic findings and coerces unknown severities", () => {
    const audit = intelResultToFinalReadInput({
      completenessScore: 72,
      categoryScores: {},
      missingFeatures: [],
      preflight: { findings: [], failed: null, probeFailures: [], filesSkipped: [], filesScanned: 1 },
      deterministicAssessment: {
        findings: [
          null,
          { title: "", file: "app/x.tsx", line: 1 },
          { title: "No file", file: "", line: 1 },
          { severity: "bogus", title: "Kept, coerced", file: "app/y.tsx", line: 2 },
        ],
      },
    });
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0].severity).toBe("medium");
  });

  it("is empty-safe when the intelligence run predates deterministic findings", () => {
    const audit = intelResultToFinalReadInput({
      completenessScore: 72,
      categoryScores: {},
      missingFeatures: [],
      preflight: { findings: [], failed: null, probeFailures: [], filesSkipped: [], filesScanned: 1 },
    });
    expect(audit.findings).toHaveLength(0);
  });
});
