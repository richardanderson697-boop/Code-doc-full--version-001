// FinalRead Q&A guardrails: no-estimates classification and citation
// validation — the rules that decide what gets charged.
import { describe, it, expect } from "vitest";
import {
  isNoEstimatesQuestion,
  NO_ESTIMATES_REPLY,
  unknownCitations,
  buildQaContext,
  normalizeDeclineTier,
  PARTIAL_DECLINE_PREFIX,
  RUNTIME_DECLINE_REPLY,
} from "../shared/finalread-qa";
import { buildFinalReadReport } from "../shared/finalread-report";

function sampleReport() {
  return buildFinalReadReport({
    projectTitle: "Test App",
    completenessScore: 60,
    categoryScores: { authentication: { score: 8 }, security: { score: 3 } },
    findings: [
      { severity: "high", title: "Hardcoded secret", file: "src/c.ts", line: 1 },
    ],
  });
}

describe("isNoEstimatesQuestion", () => {
  it("catches cost/time/effort phrasings", () => {
    for (const q of [
      "What would it cost to fix?",
      "How much will this cost?",
      "How long will it take?",
      "Give me a timeline",
      "What is the price?",
      "Estimate the effort",
    ]) {
      expect(isNoEstimatesQuestion(q)).toBe(true);
    }
  });

  it("passes ordinary stakeholder questions", () => {
    for (const q of [
      "Is this app actually finished?",
      "What's the biggest risk?",
      "Is the login real?",
      "What should be fixed first?",
    ]) {
      expect(isNoEstimatesQuestion(q)).toBe(false);
    }
  });

  it("the fixed reply promises no estimates and points at the handoff", () => {
    expect(NO_ESTIMATES_REPLY).toMatch(/don't give cost or time estimates/);
    expect(NO_ESTIMATES_REPLY).toMatch(/handoff packet/);
  });
});

describe("unknownCitations", () => {
  it("passes citations that match report titles", () => {
    const report = sampleReport();
    expect(unknownCitations(["Hardcoded secret", "Security"], report)).toEqual([]);
  });

  it("flags invented finding titles", () => {
    const report = sampleReport();
    expect(unknownCitations(["Quantum flux capacitor"], report)).toEqual([
      "Quantum flux capacitor",
    ]);
  });

  it("is case-insensitive and trims", () => {
    const report = sampleReport();
    expect(unknownCitations(["  hardcoded SECRET "], report)).toEqual([]);
  });
});

describe("buildQaContext", () => {
  it("includes verdict, buckets, and the honesty panel", () => {
    const ctx = buildQaContext(sampleReport());
    expect(ctx).toMatch(/VERDICT:/);
    expect(ctx).toMatch(/LIABILITIES/);
    expect(ctx).toMatch(/COULD NOT ESTABLISH/);
    expect(ctx).toMatch(/Hardcoded secret/);
  });

  it("includes the application summary when the audit provides one", () => {
    const withSummary = buildFinalReadReport({
      projectTitle: "Test App",
      completenessScore: 60,
      applicationSummary: "A cleaning booking platform.",
      categoryScores: {},
      findings: [],
    });
    expect(buildQaContext(withSummary)).toMatch(/WHAT THIS APP IS: A cleaning booking platform\./);
  });

  it("omits the application line when the audit has none", () => {
    expect(buildQaContext(sampleReport())).not.toMatch(/WHAT THIS APP IS/);
  });
});

describe("decline tiers", () => {
  it("normalizes tier values, defaulting to unknown", () => {
    expect(normalizeDeclineTier("partial")).toBe("partial");
    expect(normalizeDeclineTier("runtime")).toBe("runtime");
    expect(normalizeDeclineTier("unknown")).toBe("unknown");
    expect(normalizeDeclineTier("PARTIAL")).toBe("partial");
    expect(normalizeDeclineTier(undefined)).toBe("unknown");
    expect(normalizeDeclineTier("maybe")).toBe("unknown");
    expect(normalizeDeclineTier(null)).toBe("unknown");
  });

  it("the runtime reply names what would answer it and charges nothing new", () => {
    expect(RUNTIME_DECLINE_REPLY).toMatch(/never executes it/);
    expect(RUNTIME_DECLINE_REPLY).toMatch(/run it under load/);
  });

  it("the partial prefix frames the review's limits before the grounded content", () => {
    expect(PARTIAL_DECLINE_PREFIX).toMatch(/didn't analyze that specifically/);
    expect(PARTIAL_DECLINE_PREFIX).toMatch(/What it did establish/);
  });
});

describe("buildQaContext evidence", () => {
  it("includes scan evidence lines under category items", () => {
    const report = buildFinalReadReport({
      projectTitle: "Test App",
      completenessScore: 60,
      categoryScores: { security: { score: 3, reason: "Gaps." } },
      categoryEvidence: {
        security: ["server/routes/billing.ts: Stripe client usage", "no webhook handler found"],
      },
      findings: [],
    });
    const ctx = buildQaContext(report);
    expect(ctx).toMatch(/scan evidence:/);
    expect(ctx).toMatch(/Stripe client usage/);
    expect(ctx).toMatch(/no webhook handler found/);
  });

  it("omits the evidence line when a category has none", () => {
    const ctx = buildQaContext(sampleReport());
    expect(ctx).not.toMatch(/scan evidence:/);
  });
});
