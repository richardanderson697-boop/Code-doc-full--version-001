// FinalRead stakeholder Q&A route: plain-English spoken answers grounded in
// the audit report. Charging discipline mirrors /api/suggest-fix — only a
// grounded, usable answer costs credits (3 minimum via the finalreadAsk
// tier). Everything else is free:
//
// - cost/time/effort questions → fixed "no estimates" reply, no model call
// - tiered declines (resilience brief):
//     partial → the review flags the area but lacks the detail; the model
//               names what WAS established from cited findings. Grounded and
//               usable, so it charges like an answer.
//     runtime → needs live runtime observation; fixed server-side reply.
//     unknown → nothing in the review bears on it; the old flat decline.
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
  normalizeDeclineTier,
  PARTIAL_DECLINE_PREFIX,
  RUNTIME_DECLINE_REPLY,
  starterAnswer,
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
    declineTier: {
      type: "STRING",
      description:
        "When insufficientContext is true, one of: 'partial' (the review flags the area but lacks the specific detail — write what it DID establish using ONLY related cited findings, never invent the missing analysis), 'runtime' (the question can only be answered by watching the app run), or 'unknown' (nothing in the review bears on the question). Omit when answered.",
      enum: ["partial", "runtime", "unknown"],
    },
  },
  required: ["answer", "citedFindings", "insufficientContext"],
};

function systemPrompt(context: string): string {
  return (
    `You answer questions about a code review for a non-technical decision maker — an investor or business owner ` +
    `asking "should I bet on this app?". By default you speak plainly: no code, no file paths, no jargon without explanation. ` +
    `But if the stakeholder explicitly asks for technical specifics (file names, line numbers, code details), give them ` +
    `straight from the review's evidence — an explicit request overrides the plain-English default.\n\n` +
    `HARD RULES:\n` +
    `- Answer ONLY from the review below. Every claim must trace to a finding, bucket, or verdict in it.\n` +
    `- Cite the exact finding titles you relied on in citedFindings.\n` +
    `- The four starter questions always map to review sections — never decline them as uncovered: ` +
    `"Is this app actually finished?" → the verdict and completeness score; ` +
    `"What's the biggest risk?" → the highest-severity liabilities; ` +
    `"Is the login and authentication real?" → the Authentication bucket (its score, evidence, and what the scan found); ` +
    `"What should be fixed first?" → the liabilities ordered by severity.\n` +
    `- "Is X real?" means "what did the review establish about X's implementation?" — answer from the category's score ` +
    `and evidence (e.g. "the review found sign-in code with no backend, scoring it 2/10"), never from certainty the review doesn't claim.\n` +
    `- The "scan evidence" lines under each bucket item are the raw scan signals for your precision — use them to ` +
    `name specifics in plain words (e.g. "the payments code"). Quote raw file paths or line numbers ONLY when the stakeholder ` +
    `explicitly asks for them.\n` +
    `- If the review flags the area but lacks the specific detail asked for, set insufficientContext to true and ` +
    `declineTier to "partial": write what the review DID establish using ONLY related cited findings — never invent the missing analysis.\n` +
    `- If the question can only be answered by watching the app run (load, real users, production data, third-party outages), ` +
    `set insufficientContext to true and declineTier to "runtime".\n` +
    `- If nothing in the review bears on the question, set insufficientContext to true and declineTier to "unknown".\n` +
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

    // 2b. Starter pills: deterministic from the report — no model call,
    // no charge, and they can never decline.
    const starter = starterAnswer(question, report);
    if (starter) {
      return res.json({
        answer: starter.answer,
        citedFindings: starter.citedFindings,
        declined: false,
        starter: true,
      });
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
        parsed = {
          answer,
          citedFindings: cited,
          insufficientContext: declined,
          declineTier: normalizeDeclineTier(candidate.declineTier),
        };
      } catch (err: any) {
        log.warn(`finalread/ask attempt ${attempt} failed: ${err?.message || err}`);
      }
    }

    if (!parsed) {
      return res.status(502).json({
        error: "The model returned an unusable answer. No credits were charged — please try again.",
      });
    }

    // 4a. Tiered declines.
    // - partial: the review flags the area but lacks the detail. Grounded in
    //   cited findings and usable, so it charges like an answer (with a
    //   deterministic prefix). Uncited partials fall back to the flat decline.
    // - runtime: needs live runtime observation. Fixed reply, free.
    // - unknown: nothing in the review bears on it. The old flat decline, free.
    const FLAT_DECLINE_REPLY =
      "That question can't be answered from this review without guessing, so I won't guess. " +
      "It covers what the scan found — ask about the verdict, the liabilities, or what's half-built.";
    if (parsed.insufficientContext) {
      const partialGrounded =
        parsed.declineTier === "partial" &&
        !!parsed.answer &&
        unknownCitations(parsed.citedFindings, report).length === 0;
      if (partialGrounded) {
        parsed.answer = PARTIAL_DECLINE_PREFIX + parsed.answer;
        // Falls through to 4b (citation check, already satisfied) and 5 (charge).
      } else if (parsed.declineTier === "runtime") {
        return res.json({
          declined: true,
          answer: RUNTIME_DECLINE_REPLY,
          citedFindings: [],
          runtime: true,
        });
      } else {
        return res.json({
          declined: true,
          answer: FLAT_DECLINE_REPLY,
          citedFindings: [],
        });
      }
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
