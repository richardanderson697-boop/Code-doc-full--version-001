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
