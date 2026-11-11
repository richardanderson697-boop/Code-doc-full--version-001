// FinalRead ask route: the double-check, charging, and note-scoping wiring
// that pure guardrail tests can't see. Model calls, auth, and billing are
// mocked; the report build, citation check, and decline routing are real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../server/gemini", () => ({
  generateWithFallback: vi.fn(),
  extractUsage: (r: any) => ({
    inputTokens: r?.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: r?.usageMetadata?.candidatesTokenCount ?? 0,
  }),
  ai: { models: { generateContent: vi.fn() } },
  PRIMARY_MODEL: "gemini-3.6-flash",
}));

vi.mock("../server/anthropic", () => ({
  generateWithClaude: vi.fn(),
  isClaudeConfigured: vi.fn(() => true),
  CLAUDE_SONNET_MODEL: "claude-sonnet-5-5",
}));

vi.mock("../server/middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "test-user" };
    next();
  },
  requireCredits: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../server/credits", () => ({
  chargeForCall: vi.fn(async () => null),
}));

import { generateWithFallback, ai } from "../server/gemini";
import {
  generateWithClaude,
  isClaudeConfigured,
} from "../server/anthropic";
import { chargeForCall } from "../server/credits";
import finalreadRouter from "../server/routes/finalread";
import {
  PARTIAL_DECLINE_PREFIX,
  RUNTIME_DECLINE_REPLY,
  NO_ESTIMATES_REPLY,
  FREE_DECLINE_REPHRASE_NOTE,
  DOUBLE_CHECKED_DECLINE_PREFIX,
} from "../shared/finalread-qa";

const mockedFallback = vi.mocked(generateWithFallback);
const mockedClaude = vi.mocked(generateWithClaude);
const mockedGeminiGenerate = vi.mocked(ai.models.generateContent);
const mockedClaudeConfigured = vi.mocked(isClaudeConfigured);
const mockedCharge = vi.mocked(chargeForCall);

const audit = {
  projectTitle: "Test App",
  completenessScore: 60,
  categoryScores: { security: { score: 3, reason: "Gaps." } },
  findings: [
    { severity: "high", title: "Hardcoded secret", file: "src/c.ts", line: 1 },
  ],
};

function app() {
  const a = express();
  a.use(express.json({ limit: "10mb" }));
  a.use(finalreadRouter);
  return a;
}

function firstCall(candidate: any, modelName = "gemini-3.6-flash") {
  mockedFallback.mockResolvedValueOnce({
    response: { text: JSON.stringify(candidate) },
    modelName,
  } as any);
}

function groundedCandidate() {
  return {
    answer: "The app uses browser-native speech in its player.",
    citedFindings: ["Hardcoded secret"],
    insufficientContext: false,
  };
}

function unknownCandidate() {
  return { answer: "", citedFindings: [], insufficientContext: true, declineTier: "unknown" };
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: a scripted mockResolvedValueOnce that
  // a test never consumes (e.g. the runtime test, which returns before any
  // model call) must not leak into the next test.
  vi.resetAllMocks();
  mockedClaudeConfigured.mockReturnValue(true);
});

describe("finalread ask double-check", () => {
  it("verifies an unknown decline with the other model and charges the answer once", async () => {
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    mockedClaude.mockResolvedValueOnce({
      text: JSON.stringify(groundedCandidate()),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    } as any);

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does it use speech synthesis?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.answer).toMatch(/browser-native speech/);
    expect(mockedClaude).toHaveBeenCalledTimes(1);
    // The verification prompt carries the both-ways expansion examples.
    const contents = String(mockedClaude.mock.calls[0][0].contents);
    expect(contents).toMatch(/codex/);
    expect(contents).toMatch(/SpeechSynthesis/);
    expect(contents).toMatch(/stateless proxy/);
    // Charged exactly once, for the verification model — never for the decline.
    expect(mockedCharge).toHaveBeenCalledTimes(1);
    expect(mockedCharge.mock.calls[0][2]).toBe("claude-sonnet-5-5");
  });

  it("uses the Gemini leg when the first model was Claude", async () => {
    firstCall(unknownCandidate(), "claude-sonnet-5-5");
    mockedGeminiGenerate.mockResolvedValueOnce({
      text: JSON.stringify(groundedCandidate()),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    } as any);

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does it use speech synthesis?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedGeminiGenerate).toHaveBeenCalledTimes(1);
    expect(mockedCharge).toHaveBeenCalledTimes(1);
    expect(mockedCharge.mock.calls[0][2]).toBe("gemini-3.6-flash");
  });

  it("marks the decline double-checked when both models agree absent, with the note, free", async () => {
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    mockedClaude.mockResolvedValueOnce({
      text: JSON.stringify(unknownCandidate()),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    } as any);

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does it mention quantum flux?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(res.body.answer).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("falls back to the unmarked decline with the note when verification fails", async () => {
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    mockedClaude.mockRejectedValueOnce(new Error("claude down"));

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does it mention quantum flux?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).not.toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(res.body.answer).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("skips verification unmarked when Claude is unconfigured", async () => {
    mockedClaudeConfigured.mockReturnValue(false);
    firstCall(unknownCandidate(), "gemini-3.6-flash");

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does it mention quantum flux?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(res.body.answer).not.toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(res.body.answer).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("does not verify partials, charges them once, and keeps the note off", async () => {
    firstCall(
      {
        answer: "The review establishes ElevenLabs via a backend endpoint.",
        citedFindings: ["Hardcoded secret"],
        insufficientContext: true,
        declineTier: "partial",
      },
      "gemini-3.6-flash"
    );

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Are ElevenLabs keys stored?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.answer.startsWith(PARTIAL_DECLINE_PREFIX)).toBe(true);
    expect(res.body.answer).not.toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedCharge).toHaveBeenCalledTimes(1);
  });

  it("does not verify runtime tiers and keeps the note off the runtime reply", async () => {
    // No first-model script: deterministic runtime routing returns before
    // any model call, so the model must never be consulted.
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "What happens under load?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).toBe(RUNTIME_DECLINE_REPLY);
    expect(res.body.answer).not.toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(mockedFallback).not.toHaveBeenCalled();
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("returns the runtime reply without verification when the model itself routes runtime", async () => {
    firstCall(
      {
        answer: "",
        citedFindings: [],
        insufficientContext: true,
        declineTier: "runtime",
      },
      "gemini-3.6-flash"
    );

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "How does it behave when traffic grows?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).toBe(RUNTIME_DECLINE_REPLY);
    expect(res.body.answer).not.toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("gives the uncited fallback the note, free, without double-checked marking", async () => {
    firstCall(
      {
        answer: "The app uses quantum flux capacitors.",
        citedFindings: ["Quantum flux capacitor"],
        insufficientContext: false,
      },
      "gemini-3.6-flash"
    );

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does it use quantum flux?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(res.body.answer).not.toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("keeps the note off estimate replies and makes no model call", async () => {
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "How much will it cost to fix?", audit });

    expect(res.status).toBe(200);
    expect(res.body.answer).not.toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(mockedFallback).not.toHaveBeenCalled();
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("charges a verification partial once, with the partial prefix", async () => {
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    mockedClaude.mockResolvedValueOnce({
      text: JSON.stringify({
        answer: "The review establishes ElevenLabs via a backend endpoint.",
        citedFindings: ["Hardcoded secret"],
        insufficientContext: true,
        declineTier: "partial",
      }),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    } as any);

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Are ElevenLabs keys stored?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.answer.startsWith(PARTIAL_DECLINE_PREFIX)).toBe(true);
    expect(mockedCharge).toHaveBeenCalledTimes(1);
  });

  it("declines free with the note when a verification answer fails citation validation", async () => {
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    mockedClaude.mockResolvedValueOnce({
      text: JSON.stringify({
        answer: "The app uses quantum flux capacitors.",
        citedFindings: ["Quantum flux capacitor"],
        insufficientContext: false,
      }),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    } as any);

    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does it use quantum flux?", audit });

    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(res.body.answer).not.toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(mockedCharge).not.toHaveBeenCalled();
  });
});

describe("finalread ask multi-turn conversation", () => {
  const history = [
    {
      question: "What's the biggest risk?",
      answer: "The biggest risk is the hardcoded secret.",
      citedFindings: ["Hardcoded secret"],
    },
  ];

  it("carries prior turns into the model prompt, after the report, and charges once", async () => {
    firstCall(groundedCandidate());
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "What about the second finding?", audit, history });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    const contents = String(mockedFallback.mock.calls[0][0].contents);
    expect(contents).toMatch(/CONVERSATION SO FAR/);
    expect(contents).toMatch(/Q: What's the biggest risk\?/);
    expect(contents).toMatch(/A: The biggest risk is the hardcoded secret\./);
    expect(contents.indexOf("COMPLETENESS:")).toBeLessThan(
      contents.indexOf("CONVERSATION SO FAR:")
    );
    expect(mockedCharge).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed history with 400 and makes no model call", async () => {
    for (const bad of [
      "nope",
      [{ question: 1, answer: "x", citedFindings: [] }],
      [{ question: "q" }],
    ]) {
      const res = await request(app())
        .post("/api/finalread/ask")
        .send({ question: "Is this app finished?", audit, history: bad });
      expect(res.status).toBe(400);
    }
    expect(mockedFallback).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("still gives a runtime follow-up the fixed decline, free, with no model call", async () => {
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "What happens if the server goes down?", audit, history });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).toBe(RUNTIME_DECLINE_REPLY);
    expect(res.body.declineTier).toBe("runtime");
    expect(mockedFallback).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("still answers a starter pill deterministically as a follow-up, free", async () => {
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "What's the biggest risk?", audit, history });
    expect(res.status).toBe(200);
    expect(res.body.starter).toBe(true);
    expect(res.body.declined).toBe(false);
    expect(mockedFallback).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("still gives a no-estimates follow-up the fixed reply, free", async () => {
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "How much would it cost to fix?", audit, history });
    expect(res.status).toBe(200);
    expect(res.body.noEstimates).toBe(true);
    expect(res.body.answer).toBe(NO_ESTIMATES_REPLY);
    expect(mockedFallback).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("declines free when a follow-up answer cites a finding that only exists in history", async () => {
    const phantomHistory = [
      {
        question: "Is there a flux capacitor?",
        answer: "Yes, the flux capacitor is the biggest risk.",
        citedFindings: ["Quantum flux capacitor"],
      },
    ];
    firstCall({
      answer: "The flux capacitor is the biggest risk.",
      citedFindings: ["Quantum flux capacitor"],
      insufficientContext: false,
    });
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({
        question: "Tell me more about the flux capacitor.",
        audit,
        history: phantomHistory,
      });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(mockedCharge).not.toHaveBeenCalled();
  });
});

describe("finalread ask label resolver (general label fix)", () => {
  // Whistle-stop as re-asked 2026-11-10: Authentication 2/10 liability,
  // summary present, map names a FinalRead view component.
  const whistleStopAudit = {
    projectTitle: "Whistle Stop Cleaning",
    completenessScore: 56,
    applicationSummary: "A cleaning booking platform.",
    categoryScores: {
      authentication: {
        score: 2,
        reason: "No login flow exists; anyone can access admin pages.",
      },
      coreLogic: { score: 5, reason: "Booking flow is partly built." },
      security: { score: 3, reason: "Gaps." },
    },
    applicationMap: {
      entrypoint: "src/main.tsx",
      components: [
        {
          name: "FinalReadOverlay",
          filePath: "src/components/auditor/FinalReadOverlay.tsx",
        },
        { name: "BookingForm", filePath: "src/components/BookingForm.tsx" },
      ],
      endpoints: [
        { method: "POST", path: "/api/bookings", purpose: "Creates a booking" },
      ],
    },
  };

  // Automate-AI-v4 payment evidence: three dead "Get Started" buttons
  // plus the mocked-checkout verification item.
  const DEAD = (line: number) => ({
    severity: "high" as const,
    title: 'Dead "Get Started" button — no handler',
    file: "app/pricing/pricing-client.tsx",
    line,
    probe: "Dead Action",
  });
  const MOCKED = {
    severity: "medium" as const,
    title: "Checkout records sales as complete with no payment provider call",
    file: "app/api/checkout/route.ts",
    line: 39,
    probe: "Mocked Payment",
    unverified: true as const,
  };
  const paymentAudit = {
    projectTitle: "Automate-AI-v4",
    completenessScore: 62,
    categoryScores: {
      externalIntegrations: {
        score: 3,
        reason: "billing/payment processing referenced is unhandled.",
      },
    },
    findings: [DEAD(18), DEAD(28), DEAD(38), MOCKED],
  };

  it("pins the resolved label into the model prompt", async () => {
    firstCall(groundedCandidate());
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does user authentication work?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    const contents = String(mockedFallback.mock.calls[0][0].contents);
    expect(contents).toMatch(/THIS QUESTION IS ABOUT: Authentication/);
    expect(contents).toMatch(/cite it exactly as "Authentication"/);
    expect(contents).toMatch(/No login flow exists/);
  });

  it("answers a resolved unknown decline deterministically from the label, free, without the double-check", async () => {
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does user authentication work?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.starter).toBe(true);
    expect(res.body.answer).toMatch(/^Authentication: /);
    expect(res.body.answer).toMatch(/2\/10/);
    expect(res.body.citedFindings).toEqual(["Authentication"]);
    // The model was consulted once; the double-check was skipped — the
    // answer is grounded in the report by construction, not by a second
    // model's judgment.
    expect(mockedFallback).toHaveBeenCalledTimes(1);
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedGeminiGenerate).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("answers a resolved uncited model answer deterministically from the label, free", async () => {
    // The Q4 shape: the model answered from the right topic but cited
    // its own paraphrase instead of the finding title.
    firstCall(
      {
        answer: "Authentication is not really working.",
        citedFindings: ["auth does not work"],
        insufficientContext: false,
      },
      "gemini-3.6-flash"
    );
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does user authentication work?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.starter).toBe(true);
    expect(res.body.answer).toMatch(/^Authentication: /);
    expect(res.body.citedFindings).toEqual(["Authentication"]);
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("answers a resolved PURPOSE decline deterministically, citing nothing", async () => {
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({
        question:
          "Is this strictly a developer tool or can investors use it to understand software?",
        audit: whistleStopAudit,
      });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.starter).toBe(true);
    expect(res.body.answer).toMatch(/A cleaning booking platform\./);
    expect(res.body.answer).toMatch(/56\/100/);
    expect(res.body.citedFindings).toEqual([]);
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("answers a resolved STAKEHOLDER VIEW decline deterministically, citing the component", async () => {
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Is there an investor view?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.starter).toBe(true);
    expect(res.body.answer).toMatch(/this report is the stakeholder view/);
    expect(res.body.citedFindings).toEqual(["FinalReadOverlay"]);
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("charges a resolved grounded answer exactly once and does not fire the fallback", async () => {
    firstCall(
      {
        answer: "Authentication is a gap: there is no login flow.",
        citedFindings: ["Authentication"],
        insufficientContext: false,
      },
      "gemini-3.6-flash"
    );
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does user authentication work?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.answer).toBe("Authentication is a gap: there is no login flow.");
    expect(res.body.citedFindings).toEqual(["Authentication"]);
    expect(mockedCharge).toHaveBeenCalledTimes(1);
  });

  it("does not override a grounded partial citing the matched label", async () => {
    firstCall(
      {
        answer: "The review establishes the gap but not the exact login flow.",
        citedFindings: ["Authentication"],
        insufficientContext: true,
        declineTier: "partial",
      },
      "gemini-3.6-flash"
    );
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does user authentication work?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.answer.startsWith(PARTIAL_DECLINE_PREFIX)).toBe(true);
    expect(mockedCharge).toHaveBeenCalledTimes(1);
  });

  it("answers an ungrounded partial on a resolved label from the label, free", async () => {
    // Extension beyond §3.4's enumeration (recorded in spec §7): an
    // ungrounded partial routes to the same flat decline an unknown
    // decline does, so the same fallback closes it.
    firstCall(
      {
        answer: "Something about the login.",
        citedFindings: ["Quantum flux capacitor"],
        insufficientContext: true,
        declineTier: "partial",
      },
      "gemini-3.6-flash"
    );
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does user authentication work?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.starter).toBe(true);
    expect(res.body.answer).toMatch(/^Authentication: /);
    expect(res.body.citedFindings).toEqual(["Authentication"]);
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("leaves an unresolved unknown decline on the current double-check path", async () => {
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    mockedClaude.mockResolvedValueOnce({
      text: JSON.stringify(unknownCandidate()),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    } as any);
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does it mention quantum flux?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(res.body.answer).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(mockedClaude).toHaveBeenCalledTimes(1);
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("pins tied labels for the model and does not fire the fallback", async () => {
    // "what is the worst problem?" is a rephrasing of the biggest-risk
    // starter (the exact wording is a starter pill and never reaches
    // the model); it matches the risk family on both liabilities equally.
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    mockedClaude.mockResolvedValueOnce({
      text: JSON.stringify(unknownCandidate()),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    } as any);
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "what is the worst problem?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    const contents = String(mockedFallback.mock.calls[0][0].contents);
    expect(contents).toMatch(/MORE THAN ONE SECTION OF THE REVIEW/);
    expect(contents).toMatch(/- Authentication: /);
    expect(contents).toMatch(/- Security: /);
    // The fallback did not fire: the decline went through the
    // double-check and came back marked.
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(mockedClaude).toHaveBeenCalledTimes(1);
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("leaves the double-check unmarked when verification returns an empty answer without declining", async () => {
    // §4.5 logged check: the third unmarked branch (after skipped and
    // failed) — the verifier answered nothing and did not decline, so
    // the check did not complete and the decline carries no marking.
    firstCall(unknownCandidate(), "gemini-3.6-flash");
    mockedClaude.mockResolvedValueOnce({
      text: JSON.stringify({
        answer: "",
        citedFindings: [],
        insufficientContext: false,
      }),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    } as any);
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "Does it mention quantum flux?", audit });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(true);
    expect(res.body.answer).not.toContain(DOUBLE_CHECKED_DECLINE_PREFIX);
    expect(res.body.answer).toContain(FREE_DECLINE_REPHRASE_NOTE);
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("still answers Q5 grounded, charged once (regression)", async () => {
    firstCall(
      {
        answer: "Users log in through the admin pages, but there is no login flow.",
        citedFindings: ["Authentication"],
        insufficientContext: false,
      },
      "gemini-3.6-flash"
    );
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "How do users login?", audit: whistleStopAudit });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.answer).toMatch(/no login flow/);
    expect(mockedCharge).toHaveBeenCalledTimes(1);
  });

  it("still takes the deterministic payment path for the four live payment questions (regression)", async () => {
    for (const q of [
      "does this application accept payments",
      "does it collect payments",
      "Are payments mocked?",
      "our payments mocked?",
    ]) {
      const res = await request(app())
        .post("/api/finalread/ask")
        .send({ question: q, audit: paymentAudit });
      expect(res.status).toBe(200);
      expect(res.body.declined).toBe(false);
      expect(res.body.starter).toBe(true);
      expect(res.body.answer).toMatch(/"Get Started" button/);
      expect(res.body.answer).toMatch(/flagged, not established/);
      expect(res.body.citedFindings).toContain(
        'Dead "Get Started" button — no handler'
      );
      expect(res.body.citedFindings).toContain(
        "Checkout records sales as complete with no payment provider call"
      );
    }
    expect(mockedFallback).not.toHaveBeenCalled();
    expect(mockedClaude).not.toHaveBeenCalled();
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("still answers a buyer-dive follow-up grounded, with history, charged once (regression)", async () => {
    // The Automate-AI-v4 multi-turn pattern: a core question surfaces a
    // function, the buyer dives into a specific one. "What does the
    // checkout button do?" is not a payment-classifier question (no
    // payment verb), so it reaches the model with the dead-button label
    // pinned — and the grounded answer charges exactly once.
    const history = [
      {
        question: "does this application accept payments",
        answer: "No working payment path was found.",
        citedFindings: ['Dead "Get Started" button — no handler'],
      },
    ];
    firstCall(
      {
        answer: "The Get Started button does nothing when clicked.",
        citedFindings: ['Dead "Get Started" button — no handler'],
        insufficientContext: false,
      },
      "gemini-3.6-flash"
    );
    const res = await request(app())
      .post("/api/finalread/ask")
      .send({ question: "What does the checkout button do?", audit: paymentAudit, history });
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(false);
    expect(res.body.answer).toMatch(/does nothing when clicked/);
    const contents = String(mockedFallback.mock.calls[0][0].contents);
    expect(contents).toMatch(/THIS QUESTION IS ABOUT: Dead "Get Started" button/);
    expect(contents).toMatch(/CONVERSATION SO FAR/);
    expect(mockedCharge).toHaveBeenCalledTimes(1);
  });
});
