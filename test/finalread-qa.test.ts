// FinalRead Q&A guardrails: no-estimates classification and citation
// validation — the rules that decide what gets charged.
import { describe, it, expect } from "vitest";
import {
  isNoEstimatesQuestion,
  NO_ESTIMATES_REPLY,
  unknownCitations,
  buildQaContext,
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
});
