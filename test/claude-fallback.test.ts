// Claude fallback chains: failure classification, chain order per tier, the
// account-failure lite skip, the Haiku price-cliff guard, adapter shape, and
// Claude metering rates. Both provider SDKs are mocked; the real
// server/gemini.ts + server/anthropic.ts chain logic runs throughout.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const genai = vi.hoisted(() => ({
  generateContent: vi.fn(),
  generateContentStream: vi.fn(),
}));
const anthropicMock = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: genai.generateContent,
      generateContentStream: genai.generateContentStream,
    };
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: anthropicMock.create };
  },
}));

process.env.ANTHROPIC_API_KEY = "test-key";

const {
  generateWithFallback,
  generateStreamWithFallback,
  classifyGeminiFailure,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
} = await import("../server/gemini");
const {
  CLAUDE_HAIKU_MODEL,
  CLAUDE_SONNET_MODEL,
  estimateClaudeTokens,
  exceedsHaikuGuard,
} = await import("../server/anthropic");
const { creditsForUsage, extractUsage } = await import("../server/credits");

const ACCOUNT_ERR = new Error(
  "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'generate_content_free_tier_requests'"
);
const TRANSIENT_ERR = new Error("503 UNAVAILABLE: The model is overloaded");

function geminiOk(text: string) {
  return {
    text,
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  };
}

function claudeOk(text: string, input = 10, output = 5) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: input, output_tokens: output },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("classifyGeminiFailure", () => {
  it("treats quota/billing/auth failures as account-class", () => {
    expect(classifyGeminiFailure(ACCOUNT_ERR)).toBe("account");
    expect(classifyGeminiFailure(new Error("401 UNAUTHENTICATED"))).toBe("account");
    expect(classifyGeminiFailure(new Error("API key not valid"))).toBe("account");
    expect(classifyGeminiFailure(new Error("403 PERMISSION_DENIED"))).toBe("account");
    expect(classifyGeminiFailure(new Error("service paused due to your spend cap"))).toBe("account");
  });

  it("treats overloads and bare rate limits as transient", () => {
    expect(classifyGeminiFailure(TRANSIENT_ERR)).toBe("transient");
    expect(classifyGeminiFailure(new Error("429 Too Many Requests"))).toBe("transient");
    expect(classifyGeminiFailure(new Error("socket hang up"))).toBe("transient");
  });
});

describe("consumer chain", () => {
  it("returns the primary answer when Gemini is healthy", async () => {
    genai.generateContent.mockResolvedValueOnce(geminiOk("primary"));
    const { response, modelName } = await generateWithFallback({ contents: "hi" });
    expect(modelName).toBe(PRIMARY_MODEL);
    expect(response.text).toBe("primary");
    expect(anthropicMock.create).not.toHaveBeenCalled();
  });

  it("falls back to the lite model on a transient failure", async () => {
    genai.generateContent
      .mockRejectedValueOnce(TRANSIENT_ERR)
      .mockResolvedValueOnce(geminiOk("lite"));
    const { response, modelName } = await generateWithFallback({ contents: "hi" });
    expect(modelName).toBe(FALLBACK_MODEL);
    expect(response.text).toBe("lite");
    expect(anthropicMock.create).not.toHaveBeenCalled();
  });

  it("skips the lite model on an account failure and goes straight to Claude Haiku", async () => {
    genai.generateContent.mockRejectedValue(ACCOUNT_ERR);
    anthropicMock.create.mockResolvedValueOnce(claudeOk("from claude"));
    const { response, modelName } = await generateWithFallback({ contents: "hi" });
    expect(modelName).toBe(CLAUDE_HAIKU_MODEL);
    expect(response.text).toBe("from claude");
    // One Gemini attempt only: the primary. Lite shares the dead account.
    expect(genai.generateContent).toHaveBeenCalledTimes(1);
    // Adapter shape feeds the existing metering path unchanged.
    expect(extractUsage(response)).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("walks lite then Haiku when both Gemini models fail transiently", async () => {
    genai.generateContent.mockRejectedValue(TRANSIENT_ERR);
    anthropicMock.create.mockResolvedValueOnce(claudeOk("haiku saves the day"));
    const { modelName } = await generateWithFallback({ contents: "hi" });
    expect(modelName).toBe(CLAUDE_HAIKU_MODEL);
    expect(genai.generateContent).toHaveBeenCalledTimes(2);
  });

  it("with no Anthropic key, an account failure rejects after the primary only", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    genai.generateContent.mockRejectedValue(ACCOUNT_ERR);
    await expect(generateWithFallback({ contents: "hi" })).rejects.toBe(ACCOUNT_ERR);
    expect(genai.generateContent).toHaveBeenCalledTimes(1);
    expect(anthropicMock.create).not.toHaveBeenCalled();
  });

  it("skips the Haiku leg when the prompt estimate crosses the price-cliff guard", async () => {
    genai.generateContent.mockRejectedValue(ACCOUNT_ERR);
    const huge = "x".repeat(300_000); // ~115K estimated Claude tokens
    expect(exceedsHaikuGuard({ contents: huge })).toBe(true);
    await expect(generateWithFallback({ contents: huge })).rejects.toBe(ACCOUNT_ERR);
    expect(anthropicMock.create).not.toHaveBeenCalled();
  });
});

describe("premium chain (FinalRead)", () => {
  it("falls back to Claude Sonnet and never touches the lite model", async () => {
    genai.generateContent.mockRejectedValue(TRANSIENT_ERR);
    anthropicMock.create.mockResolvedValueOnce(claudeOk("sonnet answer"));
    const { response, modelName } = await generateWithFallback(
      { contents: "question" },
      undefined,
      { tier: "premium" }
    );
    expect(modelName).toBe(CLAUDE_SONNET_MODEL);
    expect(response.text).toBe("sonnet answer");
    expect(genai.generateContent).toHaveBeenCalledTimes(1);
    expect(anthropicMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: CLAUDE_SONNET_MODEL })
    );
  });

  it("with no Anthropic key, a premium failure propagates instead of downgrading", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    genai.generateContent.mockRejectedValue(TRANSIENT_ERR);
    await expect(
      generateWithFallback({ contents: "q" }, undefined, { tier: "premium" })
    ).rejects.toBe(TRANSIENT_ERR);
    expect(genai.generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("stream chain", () => {
  it("falls back to the lite stream on a transient failure", async () => {
    genai.generateContentStream
      .mockRejectedValueOnce(TRANSIENT_ERR)
      .mockResolvedValueOnce(
        (async function* () {
          yield geminiOk("lite chunk");
        })()
      );
    const seen: string[] = [];
    const onFallback = vi.fn((_e: unknown, m?: string) => seen.push(m ?? ""));
    const { stream, modelName } = await generateStreamWithFallback(
      { contents: "hi" },
      onFallback
    );
    expect(modelName).toBe(FALLBACK_MODEL);
    expect(seen).toEqual([FALLBACK_MODEL]);
    const texts: string[] = [];
    for await (const chunk of stream) texts.push(chunk.text ?? "");
    expect(texts).toEqual(["lite chunk"]);
  });

  it("streams from Claude on an account failure, skipping the lite model", async () => {
    genai.generateContentStream.mockRejectedValue(ACCOUNT_ERR);
    anthropicMock.create.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "message_start",
          message: { usage: { input_tokens: 7, output_tokens: 0 } },
        };
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        };
        yield { type: "message_delta", usage: { output_tokens: 3 } };
      })()
    );
    const onFallback = vi.fn();
    const { stream, modelName } = await generateStreamWithFallback(
      { contents: "hi" },
      onFallback
    );
    expect(modelName).toBe(CLAUDE_HAIKU_MODEL);
    expect(genai.generateContentStream).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(ACCOUNT_ERR, CLAUDE_HAIKU_MODEL);
    let text = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const chunk of stream) {
      text += chunk.text ?? "";
      const u = extractUsage(chunk);
      usage.inputTokens = Math.max(usage.inputTokens, u.inputTokens);
      usage.outputTokens = Math.max(usage.outputTokens, u.outputTokens);
    }
    expect(text).toBe("Hello");
    expect(usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});

describe("token estimation and Claude metering", () => {
  it("estimates Claude tokens above the raw character heuristic", () => {
    expect(estimateClaudeTokens("")).toBe(0);
    expect(estimateClaudeTokens("x".repeat(3500))).toBe(1350); // 3500/3.5 * 1.35
    expect(exceedsHaikuGuard({ contents: "short prompt" })).toBe(false);
  });

  it("meters Claude models at their own rates, not the Gemini default", () => {
    // 1M in + 1M out: Haiku $0.10 + $0.50 = $0.60 -> 60 credits.
    expect(
      creditsForUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, CLAUDE_HAIKU_MODEL)
    ).toBe(60);
    // Sonnet $2 + $10 = $12 -> 1200 credits.
    expect(
      creditsForUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, CLAUDE_SONNET_MODEL)
    ).toBe(1200);
    // A realistic failover Q&A call: 100K in / 10K out on Haiku = $0.015 -> 2 credits.
    expect(
      creditsForUsage({ inputTokens: 100_000, outputTokens: 10_000 }, CLAUDE_HAIKU_MODEL)
    ).toBe(2);
  });
});
