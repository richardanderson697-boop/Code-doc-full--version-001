// Gemini client, error formatting, and primary->fallback model helpers.
import { GoogleGenAI, GenerateContentConfig, GenerateContentResponse } from "@google/genai";
import { log } from "./logger";
import {
  CLAUDE_HAIKU_MODEL,
  CLAUDE_SONNET_MODEL,
  HAIKU_TOKEN_GUARD,
  exceedsHaikuGuard,
  generateWithClaude,
  isClaudeConfigured,
  logClaudeLeg,
  streamWithClaude,
} from "./anthropic";

export const PRIMARY_MODEL = "gemini-3.6-flash";
export const FALLBACK_MODEL = "gemini-3.1-flash-lite";

export const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Helper to produce user-friendly error messages when Gemini API calls fail (e.g. 401 UNAUTHENTICATED)
export function formatGeminiError(error: any): string {
  if (!process.env.GEMINI_API_KEY) {
    return "GEMINI_API_KEY is not set in environment variables. Please check your configuration.";
  }
  const msg = error?.message || String(error);
  if (msg.includes("401") || msg.includes("UNAUTHENTICATED") || msg.includes("API_KEY_INVALID") || msg.includes("API key not valid")) {
    return "Gemini API key is invalid or unauthenticated (401). Please verify your GEMINI_API_KEY environment variable.";
  }
  if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded")) {
    return "Gemini API rate limit or quota exceeded (429). Please wait a moment and try again.";
  }
  return msg || "An error occurred while calling the AI model.";
}


interface GenerateParams {
  contents: string;
  config?: GenerateContentConfig;
}

// Token counts for credit metering. The SDK surfaces these on
// response.usageMetadata (and on the final chunk of a stream).
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function extractUsage(response: any): TokenUsage {
  const meta = response?.usageMetadata ?? {};
  return {
    inputTokens: Number(meta.promptTokenCount ?? 0) || 0,
    outputTokens: Number(meta.candidatesTokenCount ?? 0) || 0,
  };
}

// Failure classification. An "account" failure (auth, billing, quota, spend
// cap) takes down the whole Gemini account — the lite model shares the same
// key, so retrying it wastes time; the chain jumps straight to Claude. A
// "transient" failure (per-model rate limit, overload) can genuinely be
// escaped by the lite model, so the in-provider retry still happens first.
export type GeminiFailureClass = "account" | "transient";

const ACCOUNT_FAILURE_MARKERS = [
  "401",
  "403",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "API_KEY_INVALID",
  "API key not valid",
  "RESOURCE_EXHAUSTED",
  "Quota exceeded",
  "QUOTA",
  "quota",
  "billing",
  "spend cap",
];

export function classifyGeminiFailure(error: any): GeminiFailureClass {
  const msg = error?.message || String(error);
  return ACCOUNT_FAILURE_MARKERS.some((marker) => msg.includes(marker))
    ? "account"
    : "transient";
}

export type FallbackTier = "consumer" | "premium";

export interface GenerateOptions {
  tier?: FallbackTier;
}

// Every route uses the same shape: try the primary model, then walk the
// fallback chain for its tier. Centralized here so the retry policy lives in
// one place. Returns which model answered so follow-up calls can reuse it,
// and so metering charges the model that actually ran.
//
// consumer: gemini-3.6-flash -> gemini-3.1-flash-lite -> Claude Haiku -> error
// premium:  gemini-3.6-flash -> Claude Sonnet -> error (FinalRead only;
//           never silently downgraded to the lite model — if Claude is
//           unconfigured or also fails, the route's own retry/decline
//           surface is the pause-and-ask)
export async function generateWithFallback(
  params: GenerateParams,
  onFallback?: () => void,
  opts?: GenerateOptions
): Promise<{ response: GenerateContentResponse; modelName: string }> {
  const tier = opts?.tier ?? "consumer";
  let notified = false;
  const notify = () => {
    if (!notified) {
      notified = true;
      if (onFallback) onFallback();
    }
  };
  try {
    const response = await ai.models.generateContent({ model: PRIMARY_MODEL, ...params });
    return { response, modelName: PRIMARY_MODEL };
  } catch (primaryErr: any) {
    const failure = classifyGeminiFailure(primaryErr);
    log.warn(
      `Primary model ${PRIMARY_MODEL} failed (${failure}-class): ${primaryErr?.message || primaryErr}`
    );
    let lastErr: unknown = primaryErr;

    if (tier === "premium") {
      if (isClaudeConfigured()) {
        notify();
        logClaudeLeg(CLAUDE_SONNET_MODEL);
        try {
          const claude = await generateWithClaude(params, CLAUDE_SONNET_MODEL);
          return {
            response: claude as unknown as GenerateContentResponse,
            modelName: CLAUDE_SONNET_MODEL,
          };
        } catch (claudeErr: any) {
          log.error(`Claude premium fallback also failed: ${claudeErr?.message || claudeErr}`);
          throw claudeErr;
        }
      }
      throw primaryErr;
    }

    if (failure === "transient") {
      try {
        notify();
        log.warn(`Falling back to ${FALLBACK_MODEL}`);
        const response = await ai.models.generateContent({ model: FALLBACK_MODEL, ...params });
        return { response, modelName: FALLBACK_MODEL };
      } catch (liteErr: any) {
        lastErr = liteErr;
        log.warn(`Fallback model ${FALLBACK_MODEL} also failed: ${liteErr?.message || liteErr}`);
      }
    } else {
      log.warn(
        `Skipping ${FALLBACK_MODEL}: account-class failure affects every Gemini model on this key`
      );
    }

    if (isClaudeConfigured()) {
      if (exceedsHaikuGuard(params)) {
        log.warn(
          `Skipping Claude Haiku leg: prompt estimate exceeds the ${HAIKU_TOKEN_GUARD}-token price-cliff guard`
        );
      } else {
        try {
          notify();
          logClaudeLeg(CLAUDE_HAIKU_MODEL);
          const claude = await generateWithClaude(params, CLAUDE_HAIKU_MODEL);
          return {
            response: claude as unknown as GenerateContentResponse,
            modelName: CLAUDE_HAIKU_MODEL,
          };
        } catch (claudeErr: any) {
          lastErr = claudeErr;
          log.error(`Claude fallback also failed: ${claudeErr?.message || claudeErr}`);
        }
      }
    }
    throw lastErr;
  }
}

export async function generateStreamWithFallback(
  params: GenerateParams,
  onFallback?: (primaryError: unknown, fallbackModel?: string) => void
): Promise<{ stream: AsyncGenerator<GenerateContentResponse>; modelName: string }> {
  try {
    const stream = await ai.models.generateContentStream({ model: PRIMARY_MODEL, ...params });
    return { stream, modelName: PRIMARY_MODEL };
  } catch (primaryErr: any) {
    const failure = classifyGeminiFailure(primaryErr);
    log.warn(
      `Primary model ${PRIMARY_MODEL} stream failed (${failure}-class): ${primaryErr?.message || primaryErr}`
    );
    let lastErr: unknown = primaryErr;

    if (failure === "transient") {
      try {
        const stream = await ai.models.generateContentStream({ model: FALLBACK_MODEL, ...params });
        if (onFallback) onFallback(primaryErr, FALLBACK_MODEL);
        return { stream, modelName: FALLBACK_MODEL };
      } catch (liteErr: any) {
        lastErr = liteErr;
        log.warn(`Fallback model ${FALLBACK_MODEL} stream also failed: ${liteErr?.message || liteErr}`);
      }
    } else {
      log.warn(
        `Skipping ${FALLBACK_MODEL}: account-class failure affects every Gemini model on this key`
      );
    }

    if (isClaudeConfigured()) {
      if (exceedsHaikuGuard(params)) {
        log.warn(
          `Skipping Claude Haiku stream leg: prompt estimate exceeds the ${HAIKU_TOKEN_GUARD}-token price-cliff guard`
        );
      } else {
        logClaudeLeg(CLAUDE_HAIKU_MODEL);
        const stream = streamWithClaude(params, CLAUDE_HAIKU_MODEL);
        if (onFallback) onFallback(primaryErr, CLAUDE_HAIKU_MODEL);
        return {
          stream: stream as unknown as AsyncGenerator<GenerateContentResponse>,
          modelName: CLAUDE_HAIKU_MODEL,
        };
      }
    }
    throw lastErr;
  }
}
