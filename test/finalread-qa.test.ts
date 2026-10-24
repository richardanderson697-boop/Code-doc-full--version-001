// FinalRead Q&A guardrails: no-estimates classification and citation
// validation — the rules that decide what gets charged.
import { describe, it, expect } from "vitest";
import {
  isNoEstimatesQuestion,
  NO_ESTIMATES_REPLY,
  isRuntimeQuestion,
  unknownCitations,
  buildQaContext,
  WAREHOUSE_CONTEXT_BUDGET,
  normalizeDeclineTier,
  PARTIAL_DECLINE_PREFIX,
  RUNTIME_DECLINE_REPLY,
  starterAnswer,
} from "../shared/finalread-qa";
import { buildFinalReadReport } from "../shared/finalread-report";
import { intelResultToFinalReadInput } from "../src/components/auditor/FinalReadOverlay";

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

describe("starterAnswer", () => {
  it("answers the four starter pills deterministically, never declining", () => {
    const report = sampleReport();

    const finished = starterAnswer("Is this app actually finished?", report)!;
    expect(finished.answer).toMatch(/60\/100/);

    const risk = starterAnswer("What's the biggest risk?", report)!;
    expect(risk.answer).toMatch(/biggest risk is/i);
    expect(risk.citedFindings.length).toBeGreaterThan(0);

    const auth = starterAnswer("Is the login and authentication real?", report)!;
    expect(auth.answer).toMatch(/Authentication:/);
    expect(auth.answer).toMatch(/8\/10/);

    const fix = starterAnswer("What should be fixed first?", report)!;
    expect(fix.answer).toMatch(/Fix in this order:/);
    expect(fix.citedFindings.length).toBeGreaterThan(0);
  });

  it("returns null for non-starter questions", () => {
    expect(starterAnswer("What does the app do?", sampleReport())).toBeNull();
    expect(starterAnswer("How much will it cost?", sampleReport())).toBeNull();
  });

  it("handles a clean report without liabilities", () => {
    const clean = buildFinalReadReport({
      projectTitle: "Clean",
      completenessScore: 95,
      categoryScores: { authentication: { score: 9 } },
      findings: [],
    });
    const risk = starterAnswer("What's the biggest risk?", clean)!;
    expect(risk.answer).toMatch(/no liabilities/i);
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

describe("isRuntimeQuestion", () => {
  it("catches the staging bug's phrasing and its variants", () => {
    for (const q of [
      "What happens if my server goes down?",
      "What happens when the server crashes?",
      "What happens if the database goes down?",
      "How does it behave under load?",
      "Can it handle a traffic spike?",
      "What if there's an outage?",
      "What happens during downtime?",
      "Does it fail over if the primary goes down?",
      "What do real users experience when it restarts?",
    ]) {
      expect(isRuntimeQuestion(q)).toBe(true);
    }
  });

  it("does not steal static, starter, or no-estimates questions", () => {
    for (const q of [
      "Is this app actually finished?",
      "What's the biggest risk?",
      "Is the login and authentication real?",
      "What should be fixed first?",
      "Does the review mention a server file?",
      "What restart policy does the code use?",
      "How much would it cost to fix?",
    ]) {
      expect(isRuntimeQuestion(q)).toBe(false);
    }
  });

  it("the runtime reply names live observation as the answer and charges nothing", () => {
    expect(RUNTIME_DECLINE_REPLY).toMatch(/never executes it/);
    expect(RUNTIME_DECLINE_REPLY).toMatch(/under load/);
  });
});

describe("buildQaContext warehouse", () => {
  function warehouseReport() {
    return buildFinalReadReport({
      projectTitle: "Whistle Stop Cleaning",
      completenessScore: 77,
      applicationSummary: "A cleaning booking platform.",
      categoryScores: {
        authentication: {
          score: 6,
          reason:
            "Firebase auth is wired in src/auth.ts:12 but sessions are never checked server-side.",
        },
      },
      applicationMap: {
        entrypoint: "src/main.tsx",
        components: [
          {
            name: "BookingForm",
            filePath: "src/components/BookingForm.tsx",
            imports: ["react", "./api"],
          },
        ],
        endpoints: [
          {
            method: "POST",
            path: "/api/bookings",
            purpose: "Creates a booking and stores photo references",
          },
        ],
      },
      fileLedger: [
        {
          filePath: "src/lib/upload.ts",
          lineCount: 120,
          description: "Handles photo uploads for booking requests",
          contribution: "Lets customers attach photos of the rooms to clean",
        },
      ],
      findings: [],
    });
  }

  it("flows warehouse fields from audit input through the report", () => {
    const report = warehouseReport();
    expect(report.applicationMap?.entrypoint).toBe("src/main.tsx");
    expect(report.applicationMap?.endpoints).toHaveLength(1);
    expect(report.fileLedger).toHaveLength(1);
    expect(report.categoryReasons?.authentication).toMatch(/Firebase auth is wired in/);
  });

  it("appends map, category detail, and ledger after the headline sections", () => {
    const ctx = buildQaContext(warehouseReport());
    expect(ctx).toMatch(/APPLICATION MAP:/);
    expect(ctx).toMatch(/POST \/api\/bookings/);
    expect(ctx).toMatch(/Creates a booking and stores photo references/);
    expect(ctx).toMatch(/CATEGORY DETAIL:/);
    expect(ctx).toMatch(/sessions are never checked server-side/);
    expect(ctx).toMatch(/FILE LEDGER:/);
    expect(ctx).toMatch(/src\/lib\/upload\.ts/);
    expect(ctx).toMatch(/Handles photo uploads for booking requests/);
    expect(ctx).toMatch(/120 lines/);
    // Order: the app summary stays first; warehouse follows the headline.
    expect(ctx.indexOf("WHAT THIS APP IS")).toBeLessThan(ctx.indexOf("APPLICATION MAP:"));
    expect(ctx.indexOf("COULD NOT ESTABLISH")).toBeLessThan(ctx.indexOf("APPLICATION MAP:"));
    expect(ctx.indexOf("APPLICATION MAP:")).toBeLessThan(ctx.indexOf("CATEGORY DETAIL:"));
    expect(ctx.indexOf("CATEGORY DETAIL:")).toBeLessThan(ctx.indexOf("FILE LEDGER:"));
  });

  it("adds no warehouse headers when the audit carried no warehouse data", () => {
    const ctx = buildQaContext(sampleReport());
    expect(ctx).not.toMatch(/APPLICATION MAP:/);
    expect(ctx).not.toMatch(/CATEGORY DETAIL:/);
    expect(ctx).not.toMatch(/FILE LEDGER:/);
    expect(ctx).not.toMatch(/truncated for size/);
  });

  it("truncates an oversized warehouse at the budget, map first, with a note", () => {
    const bigLedger = Array.from({ length: 300 }, (_, i) => ({
      filePath: `src/file-${i}.ts`,
      lineCount: 100,
      description: "x".repeat(200),
      contribution: "y".repeat(100),
    }));
    const report = buildFinalReadReport({
      projectTitle: "Huge App",
      completenessScore: 50,
      categoryScores: { coreLogic: { score: 5, reason: "Partially built." } },
      applicationMap: {
        entrypoint: "server.ts",
        endpoints: [{ method: "GET", path: "/api/health", purpose: "Health check" }],
      },
      fileLedger: bigLedger,
      findings: [],
    });
    const ctx = buildQaContext(report);
    const portion = ctx.slice(ctx.indexOf("APPLICATION MAP:"));
    expect(portion.length).toBeLessThanOrEqual(WAREHOUSE_CONTEXT_BUDGET);
    expect(ctx).toMatch(/truncated for size/);
    // Priority: the application map survives; the tail of the ledger does not.
    expect(ctx).toMatch(/\/api\/health/);
    expect(ctx).not.toMatch(/file-299/);
  });
});

describe("warehouse sanitization", () => {
  it("drops malformed application maps to undefined", () => {
    const junk = buildFinalReadReport({
      projectTitle: "Junk",
      completenessScore: 10,
      applicationMap: "not-a-map" as any,
      findings: [],
    });
    expect(junk.applicationMap).toBeUndefined();

    const empty = buildFinalReadReport({
      projectTitle: "Junk",
      completenessScore: 10,
      applicationMap: {
        entrypoint: "   ",
        components: "nope",
        endpoints: [null, { method: "GET" }],
      } as any,
      findings: [],
    });
    expect(empty.applicationMap).toBeUndefined();
  });

  it("keeps the usable parts of a partial application map", () => {
    const report = buildFinalReadReport({
      projectTitle: "Partial",
      completenessScore: 10,
      applicationMap: {
        entrypoint: "server.ts",
        components: [{ name: "App" } as any, { filePath: "src/x.ts" } as any, {} as any],
      },
      findings: [],
    });
    expect(report.applicationMap?.entrypoint).toBe("server.ts");
    expect(report.applicationMap?.components).toHaveLength(2);
    expect(report.applicationMap?.components?.[0].name).toBe("App");
  });

  it("drops ledger entries without a file path and unusable fields", () => {
    const junk = buildFinalReadReport({
      projectTitle: "Junk",
      completenessScore: 10,
      fileLedger: [{ description: "no path" }, null, "junk"] as any,
      findings: [],
    });
    expect(junk.fileLedger).toBeUndefined();

    const partial = buildFinalReadReport({
      projectTitle: "Partial",
      completenessScore: 10,
      fileLedger: [{ filePath: "a.ts", lineCount: -5, description: "   " }],
      findings: [],
    });
    expect(partial.fileLedger).toEqual([{ filePath: "a.ts" }]);
  });

  it("derives category reasons from category scores, skipping blanks", () => {
    const report = buildFinalReadReport({
      projectTitle: "Reasons",
      completenessScore: 50,
      categoryScores: {
        security: { score: 4, reason: "  No CSP header anywhere.  " },
        performance: { score: 8, reason: "   " },
        coreLogic: { score: 8 },
      },
      findings: [],
    });
    expect(report.categoryReasons).toEqual({ security: "No CSP header anywhere." });
  });
});

describe("intelResultToFinalReadInput warehouse", () => {
  it("carries the application map and file ledger out of an intelligence result", () => {
    const input = intelResultToFinalReadInput({
      completenessScore: 77,
      overallSummary: "A cleaning booking platform.",
      categoryScores: {
        authentication: { score: 6, reason: "Firebase auth is wired in." },
      },
      applicationMap: {
        entrypoint: "src/main.tsx",
        components: [],
        endpoints: [
          { method: "POST", path: "/api/bookings", purpose: "Creates a booking" },
        ],
      },
      fileLedger: [
        {
          filePath: "src/lib/upload.ts",
          lineCount: 10,
          description: "Uploads",
          contribution: "Photos",
        },
      ],
    });
    expect(input.applicationMap?.entrypoint).toBe("src/main.tsx");
    expect(input.fileLedger).toHaveLength(1);
    // The full pipeline lands the warehouse in the Q&A context.
    const ctx = buildQaContext(buildFinalReadReport(input));
    expect(ctx).toMatch(/APPLICATION MAP:/);
    expect(ctx).toMatch(/CATEGORY DETAIL:/);
    expect(ctx).toMatch(/FILE LEDGER:/);
  });

  it("drops malformed warehouse containers to undefined instead of throwing", () => {
    const input = intelResultToFinalReadInput({
      completenessScore: 10,
      applicationMap: ["not", "a", "map"],
      fileLedger: "not-an-array",
    });
    expect(input.applicationMap).toBeUndefined();
    expect(input.fileLedger).toBeUndefined();
  });
});
