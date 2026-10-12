// FinalRead stakeholder Q&A route: plain-English spoken answers grounded in
// the audit report. Charging discipline mirrors /api/suggest-fix — only a
// grounded, usable answer costs credits (3 minimum via the finalreadAsk
// tier). Everything else is free:
//
// - cost/time/effort questions → fixed "no estimates" reply, no model call
// - out-of-scope or uncited answers → declined, no charge
// - unusable model output after retries → 502, no charge
//
// The report is rebuilt server-side from the raw audit on every question;
// client-built buckets are never trusted.
import { Router } from "express";
import { asyncRoute } from "../async-route";
import {
  generateWithFallback,
  extractUsage,
} from "../gemini";
import { log } from "../logger";
import { requireAuth, requireCredits, AuthedRequest } from "../middleware/requireAuth";
import { chargeForCall } from "../credits";
import {
  buildFinalReadReport,
  type FinalReadAuditInput,
} from "../../shared/finalread-report";
import {
  isNoEstimatesQuestion,
  NO_ESTIMATES_REPLY,
  unknownCitations,
  buildQaContext,
} from "../../shared/finalread-qa";

const router = Router();

const ANSWER_SCHEMA = {
  type: "OBJECT",
  properties: {
    answer: {
      type: "STRING",
      description:
        "Plain-English answer for a non-technical decision maker, 2-5 sentences. No code, no file paths, no jargon without explanation.",
    },
    citedFindings: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Exact finding titles from the report this answer relies on.",
    },
    insufficientContext: {
      type: "BOOLEAN",
      description: "True when the question cannot be answered from the report without guessing.",
    },
  },
  required: ["answer", "citedFindings", "insufficientContext"],
};

function systemPrompt(context: string): string {
  return (
    `You answer questions about a code review for a non-technical decision maker — an investor or business owner ` +
    `asking "should I bet on this app?". You speak plainly: no code, no file paths, no jargon without explanation.\n\n` +
    `HARD RULES:\n` +
    `- Answer ONLY from the review below. Every claim must trace to a finding, bucket, or verdict in it.\n` +
    `- Cite the exact finding titles you relied on in citedFindings.\n` +
    `- If the question cannot be answered from the review without guessing, set insufficientContext to true and say so briefly.\n` +
    `- NEVER give cost, time, or effort estimates — no hours, prices, timelines, or t-shirt sizes.\n` +
    `- NEVER invent findings, files, or numbers that are not in the review.\n\n` +
    `THE REVIEW:\n${context}`
  );
}

router.post(
  "/api/finalread/ask",
  requireAuth,
  requireCredits("finalreadAsk"),
  asyncRoute(async (req: AuthedRequest, res) => {
    const { question, audit } = req.body || {};
    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "A question is required" });
    }
    if (!audit || typeof audit !== "object") {
      return res.status(400).json({ error: "An audit result is required to answer from" });
    }

    // 1. Cost/time/effort questions: fixed reply, no model call, no charge.
    if (isNoEstimatesQuestion(question)) {
      return res.json({
        answer: NO_ESTIMATES_REPLY,
        citedFindings: [],
        declined: false,
        noEstimates: true,
      });
    }

    // 2. Rebuild the report server-side; never trust client-built buckets.
    let report;
    try {
      report = buildFinalReadReport(audit as FinalReadAuditInput);
    } catch {
      return res.status(400).json({ error: "The audit result could not be read" });
    }

    // 3. Grounded model call with retries. Failed attempts are never charged.
    const prompt = systemPrompt(buildQaContext(report));
    let parsed: any = null;
    let lastResponse: any = null;
    let modelName = "";
    for (let attempt = 1; attempt <= 3 && !parsed; attempt++) {
      try {
        const gen = await generateWithFallback({
          contents: `${prompt}\n\nQUESTION: ${question.trim()}`,
          config: {
            temperature: 0.3,
            responseMimeType: "application/json",
            responseSchema: ANSWER_SCHEMA,
          },
        });
        lastResponse = gen.response;
        modelName = gen.modelName;
        const raw = (gen.response.text || "").trim();
        const candidate = JSON.parse(raw);
        const answer = String(candidate.answer || "").trim();
        const cited = Array.isArray(candidate.citedFindings)
          ? candidate.citedFindings.map((c: any) => String(c))
          : [];
        const declined =
          candidate.insufficientContext === true ||
          candidate.insufficientContext === "true" ||
          candidate.insufficientContext === 1;
        if (!answer && !declined) {
          log.warn(`finalread/ask attempt ${attempt}: empty answer without decline, retrying`);
          continue;
        }
        parsed = { answer, citedFindings: cited, insufficientContext: declined };
      } catch (err: any) {
        log.warn(`finalread/ask attempt ${attempt} failed: ${err?.message || err}`);
      }
    }

    if (!parsed) {
      return res.status(502).json({
        error: "The model returned an unusable answer. No credits were charged — please try again.",
      });
    }

    // 4a. Honest decline: out of scope for this review. Free.
    if (parsed.insufficientContext) {
      return res.json({
        declined: true,
        answer:
          "That question can't be answered from this review without guessing, so I won't guess. " +
          "It covers what the scan found — ask about the verdict, the liabilities, or what's half-built.",
        citedFindings: [],
      });
    }

    // 4b. Invented citations are a decline, not an answer. Free.
    const unknown = unknownCitations(parsed.citedFindings, report);
    if (unknown.length > 0 || !parsed.answer) {
      log.warn(`finalread/ask: uncited answer declined (unknown: ${unknown.join("; ")})`);
      return res.json({
        declined: true,
        answer:
          "I can't answer that from what's in this review without guessing, so I won't. " +
          "Try asking about the verdict, the liabilities, or a specific half-built area.",
        citedFindings: [],
      });
    }

    // 5. Only a grounded, usable answer reaches the charge.
    const balance = await chargeForCall(
      req.user!.id,
      extractUsage(lastResponse),
      modelName,
      "ai finalread ask"
    );
    if (balance != null) res.set("X-Credits-Balance", String(balance));
    return res.json({
      answer: parsed.answer,
      citedFindings: parsed.citedFindings,
      declined: false,
    });
  })
);

export default router;
