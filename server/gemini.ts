// Gemini client, error formatting, and primary->fallback model helpers.
import { GoogleGenAI, GenerateContentConfig, GenerateContentResponse } from "@google/genai";
import { log } from "./logger";

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

// Every route used the same shape: try the primary model, fall back to the
// lite model when it is busy. Centralized here so the retry policy lives in
// one place. Returns which model answered so follow-up calls can reuse it.
export async function generateWithFallback(
  params: GenerateParams,
  onFallback?: () => void
): Promise<{ response: GenerateContentResponse; modelName: string }> {
  try {
    const response = await ai.models.generateContent({ model: PRIMARY_MODEL, ...params });
    return { response, modelName: PRIMARY_MODEL };
  } catch (primaryErr) {
    log.warn(`Primary model ${PRIMARY_MODEL} busy or failing, falling back to ${FALLBACK_MODEL}`);
    if (onFallback) onFallback();
    const response = await ai.models.generateContent({ model: FALLBACK_MODEL, ...params });
    return { response, modelName: FALLBACK_MODEL };
  }
}

export async function generateStreamWithFallback(
  params: GenerateParams,
  onFallback?: (primaryError: unknown) => void
): Promise<{ stream: AsyncGenerator<GenerateContentResponse>; modelName: string }> {
  try {
    const stream = await ai.models.generateContentStream({ model: PRIMARY_MODEL, ...params });
    return { stream, modelName: PRIMARY_MODEL };
  } catch (primaryErr) {
    log.warn(`Primary model ${PRIMARY_MODEL} busy or failing, falling back to ${FALLBACK_MODEL}`);
    if (onFallback) onFallback(primaryErr);
    const stream = await ai.models.generateContentStream({ model: FALLBACK_MODEL, ...params });
    return { stream, modelName: FALLBACK_MODEL };
  }
}
