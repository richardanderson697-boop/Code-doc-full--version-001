// FinalRead stakeholder report builder: deterministic bucketing, verdict,
// and the mandatory could-not-establish panel.
import { describe, it, expect } from "vitest";
import {
  buildFinalReadReport,
  type FinalReadAuditInput,
} from "../shared/finalread-report";

function baseInput(overrides: Partial<FinalReadAuditInput> = {}): FinalReadAuditInput {
  return {
    projectTitle: "Test App",
    completenessScore: 72,
    categoryScores: {
      authentication: { score: 8, reason: "Login and sessions implemented." },
      security: { score: 5, reason: "Some gaps remain." },
      documentationVerified: { score: 2, reason: "Docs do not match code." },
    },
    findings: [
      {
        severity: "high",
        title: "Hardcoded secret",
        file: "src/config.ts",
        line: 12,
        probe: "secrets",
        remediation: "Move to env.",
      },
      { severity: "low", title: "Verbose logging", file: "src/a.ts", line: 3 },
    ],
    missingFeatures: [{ category: "Notifications", feature: "Email alerts", reason: "Configured but never sent." }],
    scanGaps: { failed: null, probeFailures: [], filesSkipped: [], filesScanned: 40 },
    ...overrides,
  };
}

describe("buildFinalReadReport bucketing", () => {
  it("buckets categories by score band", () => {
    const r = buildFinalReadReport(baseInput());
    expect(r.working.map((i) => i.title)).toContain("Authentication");
    expect(r.halfBuilt.map((i) => i.title)).toContain("Security");
    expect(r.liabilities.map((i) => i.title)).toContain("Documentation verified");
  });

  it("sends critical/high preflight findings to liabilities and skips the rest", () => {
    const r = buildFinalReadReport(baseInput());
    expect(r.liabilities.map((i) => i.title)).toContain("Hardcoded secret");
    const all = [...r.working, ...r.halfBuilt, ...r.liabilities].map((i) => i.title);
    expect(all).not.toContain("Verbose logging");
  });

  it("puts missing features in half-built", () => {
    const r = buildFinalReadReport(baseInput());
    expect(r.halfBuilt.map((i) => i.title)).toContain("Email alerts");
  });

  it("clamps out-of-range scores", () => {
    const r = buildFinalReadReport(
      baseInput({
        completenessScore: 140,
        categoryScores: { security: { score: -4 } },
      })
    );
    expect(r.completenessScore).toBe(100);
    expect(r.liabilities.map((i) => i.title)).toContain("Security");
  });
});

describe("buildFinalReadReport verdict", () => {
  it("picks the verdict band from the completeness score", () => {
    expect(buildFinalReadReport(baseInput({ completenessScore: 90 })).verdict).toMatch(
      /substantially finished/
    );
    expect(buildFinalReadReport(baseInput({ completenessScore: 65 })).verdict).toMatch(
      /partly built/
    );
    expect(buildFinalReadReport(baseInput({ completenessScore: 30 })).verdict).toMatch(
      /significant unfinished work/
    );
  });

  it("calls out liabilities in the verdict when present", () => {
    const r = buildFinalReadReport(baseInput());
    expect(r.verdict).toMatch(/liabilit/);
  });
});

describe("buildFinalReadReport couldNotEstablish", () => {
  it("is always non-empty, even for a clean scan", () => {
    const r = buildFinalReadReport(baseInput());
    expect(r.couldNotEstablish.length).toBeGreaterThan(0);
    expect(r.couldNotEstablish.join(" ")).toMatch(/never executed/);
  });

  it("names failed probes and skipped files", () => {
    const r = buildFinalReadReport(
      baseInput({
        scanGaps: {
          failed: null,
          probeFailures: [{ probe: "secrets", error: "timeout" }],
          filesSkipped: [{ path: "big.bin", reason: "too large" }],
          filesScanned: 39,
        },
      })
    );
    const text = r.couldNotEstablish.join(" ");
    expect(text).toMatch(/secrets/);
    expect(text).toMatch(/1 file was excluded/);
  });

  it("defaults the project title when none is given", () => {
    const r = buildFinalReadReport(baseInput({ projectTitle: undefined }));
    expect(r.projectTitle).toBe("Reviewed project");
  });
});

describe("buildFinalReadReport category evidence", () => {
  it("attaches condensed evidence lines to category bucket items", () => {
    const r = buildFinalReadReport(
      baseInput({
        categoryEvidence: {
          security: [
            "server/routes/billing.ts: Stripe client usage",
            "no webhook handler found",
          ],
          authentication: ["better-auth session calls"],
        },
      })
    );
    const sec = r.halfBuilt.find((i) => i.title === "Security");
    expect(sec?.evidence).toEqual([
      "server/routes/billing.ts: Stripe client usage",
      "no webhook handler found",
    ]);
    const auth = r.working.find((i) => i.title === "Authentication");
    expect(auth?.evidence).toEqual(["better-auth session calls"]);
  });

  it("caps evidence at 6 lines and trims long lines", () => {
    const r = buildFinalReadReport(
      baseInput({
        categoryEvidence: {
          security: ["x".repeat(300)].concat(
            Array.from({ length: 10 }, (_, i) => `line ${i}`)
          ),
        },
      })
    );
    const sec = r.halfBuilt.find((i) => i.title === "Security");
    expect(sec?.evidence?.length).toBe(6);
    expect(sec?.evidence?.[0]).toMatch(/…$/);
    expect(sec?.evidence?.every((l) => l.length <= 180)).toBe(true);
  });

  it("leaves evidence undefined when the audit carries none", () => {
    const r = buildFinalReadReport(baseInput());
    const all = [...r.working, ...r.halfBuilt, ...r.liabilities];
    expect(all.every((i) => i.evidence === undefined)).toBe(true);
  });

  it("ignores evidence keys with no matching category score", () => {
    const r = buildFinalReadReport(
      baseInput({ categoryEvidence: { notACategory: ["something"] } })
    );
    const all = [...r.working, ...r.halfBuilt, ...r.liabilities];
    expect(all.every((i) => i.evidence === undefined)).toBe(true);
  });
});
