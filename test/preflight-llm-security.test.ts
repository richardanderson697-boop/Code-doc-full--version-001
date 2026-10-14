// LLM10 Unbounded Consumption probe: an LLM call with no output cap is a
// Denial-of-Wallet risk. Must cover @google/genai (models.generateContent)
// as well as the OpenAI/Anthropic-style SDKs — the probe exists because of
// a real Gemini runaway-bill incident, so missing the Gemini pattern would
// be the probe failing its own origin story.
import { describe, it, expect } from "vitest";
import { probeLLMSecurity } from "../server/preflight/vendor/lib/probes/llm.js";

const GEMINI_UNBOUNDED = `
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const response = await ai.models.generateContent({
  model: "gemini-2.0-flash",
  contents: "Summarize: " + userInput,
});`;

const GEMINI_BOUNDED = `
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const response = await ai.models.generateContent({
  model: "gemini-2.0-flash",
  contents: "Summarize: " + userInput,
  config: { maxOutputTokens: 500 },
});`;

const OPENAI_UNBOUNDED = `
import OpenAI from "openai";
const openai = new OpenAI();
const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: userInput }],
});`;

function unboundedIds(files: { path: string; content: string }[]): string[] {
  return probeLLMSecurity(files)
    .filter((f: any) => f.id.startsWith("llm-unbounded-"))
    .map((f: any) => f.id);
}

describe("probeLLMSecurity — LLM10 unbounded consumption", () => {
  it("flags a @google/genai call with no output cap", () => {
    const ids = unboundedIds([{ path: "server/ai.js", content: GEMINI_UNBOUNDED }]);
    expect(ids).toEqual(["llm-unbounded-server/ai.js"]);
  });

  it("stays quiet when maxOutputTokens is set (@google/genai)", () => {
    const ids = unboundedIds([{ path: "server/ai.js", content: GEMINI_BOUNDED }]);
    expect(ids).toEqual([]);
  });

  it("still flags OpenAI-style calls with no max_tokens (existing behavior)", () => {
    const ids = unboundedIds([{ path: "server/ai.js", content: OPENAI_UNBOUNDED }]);
    expect(ids).toEqual(["llm-unbounded-server/ai.js"]);
  });
});
