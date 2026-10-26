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
  PARTIAL_SCOPE_GUIDANCE,
  RUNTIME_DECLINE_REPLY,
  FLAT_DECLINE_REPLY,
  FREE_DECLINE_REPHRASE_NOTE,
  DOUBLE_CHECKED_DECLINE_PREFIX,
  formatUnknownDecline,
  formatUncitedDecline,
  questionTerms,
  warehouseLineMatches,
  selectWarehouseLines,
  pickVerificationModel,
  doubleCheckPrompt,
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

function warehouseReport() {
  return buildFinalReadReport({
    projectTitle: "Test App",
    completenessScore: 60,
    categoryScores: {
      coreLogic: {
        score: 6,
        reason:
          "Character continuity is tracked through a fact ledger that merges character lists",
      },
    },
    findings: [
      { severity: "high", title: "Hardcoded secret", file: "src/c.ts", line: 1 },
    ],
    applicationMap: {
      entrypoint: "src/server.ts",
      components: [
        {
          name: "BookCodex",
          filePath: "src/components/BookCodex.tsx",
          imports: ["src/lib/factLedger.ts"],
        },
      ],
      endpoints: [
        {
          method: "POST",
          path: "/api/elevenlabs/tts",
          purpose: "Stateless ElevenLabs text-to-speech proxy",
        },
      ],
    },
    fileLedger: [
      {
        filePath: "src/lib/factLedger.ts",
        lineCount: 698,
        description: "Macro plot arc analyzer and character continuity ledger",
        contribution: "tracks character roles and chapter facts",
      },
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

  it("passes warehouse-grounded citations: paths, identifiers, and phrases", () => {
    const report = warehouseReport();
    expect(
      unknownCitations(
        [
          "src/lib/factLedger.ts",
          "factLedger.ts",
          "lib/factLedger.ts",
          "src/components/BookCodex.tsx",
          "BookCodex",
          "POST /api/elevenlabs/tts",
          "/api/elevenlabs/tts",
          "src/server.ts",
          "Stateless ElevenLabs text-to-speech proxy",
          "character continuity ledger",
          "tracks character roles",
          "fact ledger that merges character lists",
        ],
        report
      )
    ).toEqual([]);
  });

  it("still passes finding titles alongside warehouse citations", () => {
    const report = warehouseReport();
    expect(
      unknownCitations(["Hardcoded secret", "src/lib/factLedger.ts"], report)
    ).toEqual([]);
  });

  it("is case-insensitive and trims warehouse citations", () => {
    const report = warehouseReport();
    expect(
      unknownCitations(
        ["  FACTLEDGER.TS ", "  Character Continuity Ledger "],
        report
      )
    ).toEqual([]);
  });

  it("still flags invented citations, including invented file paths", () => {
    const report = warehouseReport();
    expect(
      unknownCitations(
        [
          "Quantum flux capacitor",
          "src/lib/nonexistent.ts",
          "character teleportation matrix",
        ],
        report
      )
    ).toEqual([
      "Quantum flux capacitor",
      "src/lib/nonexistent.ts",
      "character teleportation matrix",
    ]);
  });

  it("does not pass generic single-word citations", () => {
    const report = warehouseReport();
    expect(unknownCitations(["characters", "audio", "voices"], report)).toEqual([
      "characters",
      "audio",
      "voices",
    ]);
  });

  it("does not pass invented citations that embed a real phrase", () => {
    const report = warehouseReport();
    expect(
      unknownCitations(
        [
          "the character continuity ledger uses quantum entanglement to teleport chapters",
        ],
        report
      )
    ).toEqual([
      "the character continuity ledger uses quantum entanglement to teleport chapters",
    ]);
  });

  it("does not pass phrases stitched across two warehouse fields", () => {
    const report = warehouseReport();
    expect(
      unknownCitations(["proxy tracks character roles"], report)
    ).toEqual(["proxy tracks character roles"]);
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

  it("truncates an oversized warehouse at the runaway ceiling, map first, with a note", () => {
    const bigLedger = Array.from({ length: 300 }, (_, i) => ({
      filePath: `src/file-${i}.ts`,
      lineCount: 100,
      description: "x".repeat(2000),
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

describe("warehouse runaway ceiling", () => {
  it("is raised far above the old 24,000-char budget", () => {
    expect(WAREHOUSE_CONTEXT_BUDGET).toBe(500000);
  });

  it("passes a 72-file-scale warehouse through whole, with no truncation note", () => {
    const ledger = Array.from({ length: 300 }, (_, i) => ({
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
      fileLedger: ledger,
      findings: [],
    });
    const ctx = buildQaContext(report);
    expect(ctx).not.toMatch(/truncated for size/);
    expect(ctx).toMatch(/file-299/);
  });
});

describe("questionTerms and retention", () => {
  it("lowercases, drops stopwords and short tokens, de-duplicates", () => {
    expect(questionTerms("Does this app use Speech Synthesis?")).toEqual([
      "use",
      "speech",
      "synthesis",
    ]);
    expect(questionTerms("Is it an OS thing?")).toEqual(["thing"]);
    expect(questionTerms("")).toEqual([]);
  });

  it("matches case-insensitively with cheap plural/singular variants", () => {
    expect(warehouseLineMatches("- Holds the api key for TTS", ["keys"])).toBe(true);
    expect(warehouseLineMatches("- Handles SpeechSynthesis playback", ["speech"])).toBe(true);
    expect(warehouseLineMatches("- Handles Stripe billing", ["keys"])).toBe(false);
    expect(warehouseLineMatches("- Handles Stripe billing", [])).toBe(false);
  });

  function retentionReport() {
    const filler = Array.from({ length: 20 }, (_, i) => ({
      filePath: `src/file-${i}.ts`,
      lineCount: 100,
      description: "Filler module for test",
      contribution: "Nothing",
    }));
    return buildFinalReadReport({
      projectTitle: "Retention App",
      completenessScore: 50,
      categoryScores: { coreLogic: { score: 5, reason: "Partially built." } },
      applicationMap: {
        entrypoint: "server.ts",
        endpoints: [{ method: "GET", path: "/api/health", purpose: "Health check" }],
      },
      fileLedger: [
        ...filler,
        {
          filePath: "src/components/AudioBookPlayer.tsx",
          lineCount: 200,
          description: "Handles SpeechSynthesis playback",
          contribution: "Plays chapters aloud",
        },
      ],
      findings: [],
    });
  }

  it("admits question-matching lines first, within the ceiling, not exempt from it", () => {
    const report = retentionReport();
    const withQuestion = selectWarehouseLines(report, "speech synthesis", 350).join("\n");
    const withoutQuestion = selectWarehouseLines(report, undefined, 350).join("\n");
    // The player line sits last in the ledger; without the question it is
    // cut, with the question it is admitted first.
    expect(withQuestion).toMatch(/SpeechSynthesis/);
    expect(withoutQuestion).not.toMatch(/SpeechSynthesis/);
    // Matching lines come before unrelated lines, and the ceiling still
    // applies: the note is present and the tail stays cut.
    expect(withQuestion.indexOf("SpeechSynthesis")).toBeLessThan(
      withQuestion.indexOf("/api/health")
    );
    expect(withQuestion).toMatch(/truncated for size/);
    expect(withoutQuestion).toMatch(/truncated for size/);
    expect(withQuestion).toMatch(/\/api\/health/);
  });

  it("buildQaContext passes the question through and stays identical with no match", () => {
    const report = retentionReport();
    expect(buildQaContext(report, "zzz qqq")).toBe(buildQaContext(report));
    expect(buildQaContext(report, "")).toBe(buildQaContext(report));
    expect(buildQaContext(report, "speech synthesis")).toMatch(/SpeechSynthesis/);
  });
});

describe("double-check helpers", () => {
  it("picks the other premium model, never the same one or the lite model", () => {
    expect(pickVerificationModel(false, true)).toBe("claude");
    expect(pickVerificationModel(true, true)).toBe("gemini");
    expect(pickVerificationModel(true, false)).toBe("gemini");
    expect(pickVerificationModel(false, false)).toBeNull();
  });

  it("the verification prompt expands terms both ways with the dogfood examples", () => {
    const prompt = doubleCheckPrompt("THE REVIEW", "Does it use a codex?");
    expect(prompt).toMatch(/BOTH ways/);
    expect(prompt).toMatch(/codex/);
    expect(prompt).toMatch(/fact ledger/);
    expect(prompt).toMatch(/SpeechSynthesis/);
    expect(prompt).toMatch(/native browser speech/);
    expect(prompt).toMatch(/free OS voices/);
    expect(prompt).toMatch(/stateless proxy/);
    expect(prompt).toMatch(/whether keys are stored/);
    expect(prompt).toMatch(/THE REVIEW/);
    expect(prompt).toMatch(/Does it use a codex\?/);
  });
});

describe("free-decline rephrase note scoping", () => {
  it("uses the exact founder-approved wording", () => {
    expect(FREE_DECLINE_REPHRASE_NOTE).toBe(
      "This question wasn't answered, so no credit was charged. Rephrasing sometimes finds it — try describing what you're asking about in plain words, rather than using a product or feature name."
    );
  });

  it("rides on unknown and uncited declines, marked only when double-checked", () => {
    expect(formatUnknownDecline(false)).toContain(FLAT_DECLINE_REPLY);
    expect(formatUnknownDecline(false)).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(formatUnknownDecline(false)).not.toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(formatUnknownDecline(true)).toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(formatUnknownDecline(true)).toContain(FLAT_DECLINE_REPLY);
    expect(formatUnknownDecline(true)).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(formatUncitedDecline()).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(formatUncitedDecline()).not.toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
  });

  it("never appears in the charged or policy replies themselves", () => {
    expect(PARTIAL_DECLINE_PREFIX).not.toContain("no credit was charged");
    expect(RUNTIME_DECLINE_REPLY).not.toContain("no credit was charged");
    expect(NO_ESTIMATES_REPLY).not.toContain("no credit was charged");
  });
});

describe("partial scope guardrail", () => {
  it("scopes gaps to the surfaced material and forbids whole-review absence claims", () => {
    expect(PARTIAL_SCOPE_GUIDANCE).toMatch(/not found in the material surfaced for this question/);
    expect(PARTIAL_SCOPE_GUIDANCE).toMatch(/the review does not detail/);
    expect(PARTIAL_SCOPE_GUIDANCE).toMatch(/absence from it is not absence from the review/);
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

describe("needsVerification in Q&A", () => {
  function verificationReport() {
    return buildFinalReadReport({
      projectTitle: "Test App",
      completenessScore: 60,
      categoryScores: {},
      findings: [
        {
          severity: "critical",
          title: "POST /api/auth/reset-password without auth check",
          file: "server/routes/auth.ts",
          line: 179,
          probe: "API Route Auth",
          evidence: "app.post('/api/auth/reset-password', handler)",
          unverified: true,
        },
      ],
    });
  }

  it("accepts a verification item title as a citation", () => {
    const report = verificationReport();
    expect(
      unknownCitations(["POST /api/auth/reset-password without auth check"], report)
    ).toEqual([]);
  });

  it("answers 'what still needs verifying' as flagged, never established", () => {
    const report = verificationReport();
    const answer = starterAnswer("What still needs verifying?", report);
    expect(answer).not.toBeNull();
    expect(answer!.answer).toMatch(/flagged/i);
    expect(answer!.answer).toMatch(/not established/i);
    expect(answer!.answer).toMatch(/none counted as a liability/i);
    expect(answer!.answer).not.toMatch(/is a liability/i);
    expect(answer!.answer).toContain("POST /api/auth/reset-password without auth check");
    expect(answer!.citedFindings).toEqual([
      "POST /api/auth/reset-password without auth check",
    ]);
  });

  it("says nothing is flagged when the verification bucket is empty", () => {
    const report = sampleReport();
    const answer = starterAnswer("What still needs verifying?", report);
    expect(answer).not.toBeNull();
    expect(answer!.answer).toMatch(/flagged nothing for developer verification/);
  });

  it("keeps verification items out of the biggest-risk, fix-first, and login shortcuts", () => {
    const report = verificationReport();
    const risk = starterAnswer("What's the biggest risk?", report);
    expect(risk!.answer).not.toContain("reset-password");
    const fixFirst = starterAnswer("What should be fixed first?", report);
    expect(fixFirst!.answer).toMatch(/no liabilities to fix/);
    const login = starterAnswer("Is the login and authentication real?", report);
    expect(login!.answer).toMatch(/did not assess authentication/);
  });

  it("prints a NEEDS VERIFICATION section after liabilities, framed as flagged", () => {
    const report = verificationReport();
    const ctx = buildQaContext(report);
    expect(ctx).toMatch(/NEEDS VERIFICATION/);
    expect(ctx).toMatch(/NOT established/);
    expect(
      ctx.indexOf("LIABILITIES") < ctx.indexOf("NEEDS VERIFICATION") &&
        ctx.indexOf("NEEDS VERIFICATION") < ctx.indexOf("HALF-BUILT")
    ).toBe(true);
  });

  it("carries the unverified flag through the overlay input mapping", () => {
    const input = intelResultToFinalReadInput({
      completenessScore: 60,
      preflight: {
        findings: [
          {
            severity: "low",
            title: "POST /api/billing/hook — handler delegated out of this file, auth could not be verified",
            file: "server/routes/billing.ts",
            line: 42,
            probe: "API Route Auth",
            unverified: true,
          },
        ],
      },
    });
    expect(input.findings?.[0].unverified).toBe(true);
    const report = buildFinalReadReport(input);
    expect(report.needsVerification.map((i) => i.title)).toEqual([
      "POST /api/billing/hook — handler delegated out of this file, auth could not be verified",
    ]);
    expect(report.liabilities).toEqual([]);
  });
});
