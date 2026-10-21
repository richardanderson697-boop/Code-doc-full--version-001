// Claude (Anthropic) provider: the cross-provider fallback leg used by
// server/gemini.ts when the whole Gemini account is unavailable (billing
// lockout, auth failure, quota exhaustion) — a failure domain Gemini's own
// lite model cannot escape because it shares the same key and account.
//
// Adapters return Gemini-shaped results ({ text, usageMetadata }) so every
// caller, usage extractor, and the credit meter keep working unchanged.
// modelName is the Claude model id, so metering and logs always name the
// provider that actually answered — never a silent swap.
//
// Inert without ANTHROPIC_API_KEY: isClaudeConfigured() is false and the
// fallback chains behave exactly as they did before this module existed.
import Anthropic from "@anthropic-ai/sdk";
import type { GenerateContentConfig } from "@google/genai";
import { log } from "./logger";

// Exact model ID strings must match the Anthropic console for the account in
// use; override via env if the console shows different IDs.
export const CLAUDE_HAIKU_MODEL =
  process.env.CLAUDE_HAIKU_MODEL || "claude-haiku-5-5";
export const CLAUDE_SONNET_MODEL =
  process.env.CLAUDE_SONNET_MODEL || "claude-sonnet-5-5";

const DEFAULT_MAX_TOKENS = 32768;

// Haiku bills at 5x once a prompt passes 100K tokens. The guard sits below
// the cliff with margin; prompts estimated above it skip the Haiku leg
// entirely (honest failure beats a silent 5x charge).
export const HAIKU_TOKEN_GUARD = 90_000;

let client: Anthropic | null = null;

export function isClaudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in environment variables.");
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface ClaudeParams {
  contents: string;
  config?: GenerateContentConfig;
}

// Claude tokenizers count roughly 35% more tokens than Gemini-era estimates
// for the same text; chars/3.5 is a conservative base for code-heavy
// prompts. Used ONLY for pre-flight decisions (the price-cliff guard) —
// billing/metering always uses the token counts Anthropic returns.
export function estimateClaudeTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil((text.length / 3.5) * 1.35);
}

export function estimateClaudePromptTokens(params: ClaudeParams): number {
  const system =
    typeof params.config?.systemInstruction === "string"
      ? params.config.systemInstruction
      : "";
  return estimateClaudeTokens(params.contents) + estimateClaudeTokens(system);
}

export function exceedsHaikuGuard(params: ClaudeParams): boolean {
  return estimateClaudePromptTokens(params) > HAIKU_TOKEN_GUARD;
}

function toMessageCreate(params: ClaudeParams, model: string) {
  const cfg = params.config ?? {};
  const system =
    typeof cfg.systemInstruction === "string" ? cfg.systemInstruction : undefined;
  const temperature =
    typeof cfg.temperature === "number"
      ? Math.min(Math.max(cfg.temperature, 0), 1) // Anthropic range is 0–1
      : undefined;
  const max_tokens =
    typeof cfg.maxOutputTokens === "number" && cfg.maxOutputTokens > 0
      ? cfg.maxOutputTokens
      : DEFAULT_MAX_TOKENS;
  return {
    model,
    max_tokens,
    ...(system ? { system } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    messages: [{ role: "user" as const, content: params.contents }],
  };
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const lines = trimmed.split("\n");
  lines.shift();
  if (lines.length && lines[lines.length - 1].trim().startsWith("```")) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

export interface ClaudeResult {
  text: string;
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

function adaptMessage(message: Anthropic.Message, wantJson: boolean): ClaudeResult {
  let text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (wantJson) text = stripJsonFences(text);
  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  return {
    text,
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens,
    },
  };
}

export async function generateWithClaude(
  params: ClaudeParams,
  model: string
): Promise<ClaudeResult> {
  const message = await getClient().messages.create(toMessageCreate(params, model));
  return adaptMessage(
    message,
    params.config?.responseMimeType === "application/json"
  );
}

// Streaming twin: yields Gemini-shaped chunks ({ text, usageMetadata }) so
// the SSE route's chunk loop and its max()-based usage metering work as-is.
// A final usage-only chunk guarantees the meter sees the output token count
// even when the last text delta arrived before the final usage event.
export async function* streamWithClaude(
  params: ClaudeParams,
  model: string
): AsyncGenerator<ClaudeResult> {
  const stream = await getClient().messages.create({
    ...toMessageCreate(params, model),
    stream: true,
  });
  let inputTokens = 0;
  let outputTokens = 0;
  const usage = () => ({
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: inputTokens + outputTokens,
  });
  for await (const event of stream) {
    if (event.type === "message_start") {
      inputTokens = event.message.usage?.input_tokens ?? inputTokens;
    } else if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield { text: event.delta.text, usageMetadata: usage() };
    } else if (event.type === "message_delta") {
      outputTokens = event.usage?.output_tokens ?? outputTokens;
    }
  }
  yield { text: "", usageMetadata: usage() };
}

export function logClaudeLeg(model: string): void {
  log.warn(`Answering with Claude (${model}) — Gemini provider unavailable`);
}
