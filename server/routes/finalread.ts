// FinalRead stakeholder Q&A route: plain-English spoken answers grounded in
// the audit report. Charging discipline mirrors /api/suggest-fix — only a
// grounded, usable answer costs credits (3 minimum via the finalreadAsk
// tier). Everything else is free:
//
// - cost/time/effort questions → fixed "no estimates" reply, no model call
// - runtime-pattern questions ("what happens if the server goes down") →
//   fixed runtime reply, no model call (deterministic; the model misroutes these)
// - tiered declines (resilience brief):
//     partial → the review flags the area but lacks the detail; the model
//               names what WAS established from cited findings. Grounded and
//               usable, so it charges like an answer.
//     runtime → needs live runtime observation; fixed server-side reply.
//     unknown → nothing in the review bears on it; one double-check call
//               to the other premium model first. If it agrees, the flat
//               decline marked as double-checked, plus the free-decline
//               rephrase note. If the check can't run or fails, the flat
//               decline unmarked, still with the note.
// - free declines carry the rephrase note (unknown + uncited-fallback
//   only); partials (charged), runtime, and estimate replies never do.
// - partial gaps are scoped to the material surfaced for the question,
//   never asserted about the whole review.
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
  ai,
  PRIMARY_MODEL,
} from "../gemini";
import {
  generateWithClaude,
  isClaudeConfigured,
  CLAUDE_SONNET_MODEL,
} from "../anthropic";
import { log } from "../logger";
import { requireAuth, requireCredits, AuthedRequest } from "../middleware/requireAuth";
import { chargeForCall } from "../credits";
import {
  buildFinalReadReport,
  type FinalReadAuditInput,
  type FinalReadReport,
} from "../../shared/finalread-report";
import {
  isNoEstimatesQuestion,
  NO_ESTIMATES_REPLY,
  isRuntimeQuestion,
  unknownCitations,
  buildQaContext,
  normalizeDeclineTier,
  PARTIAL_DECLINE_PREFIX,
  PARTIAL_SCOPE_GUIDANCE,
  RUNTIME_DECLINE_REPLY,
  formatUnknownDecline,
  formatUncitedDecline,
  doubleCheckPrompt,
  pickVerificationModel,
  starterAnswer,
} from "../../shared/finalread-qa";

import type { GenerateContentConfig } from "@google/genai";

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
        "When insufficientContext is true, one of: 'partial' (the review flags the area but lacks the specific detail — write what it DID establish using ONLY related cited findings, never invent the missing analysis, and scope any gap to the material surfaced for this question — never claim the whole review lacks it), 'runtime' (the question can only be answered by watching the app run), or 'unknown' (nothing in the review bears on the question). Omit when answered.",
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
    `- Answer ONLY from the review below. Every claim must trace to a finding, bucket, verdict, or the warehouse ` +
    `detail (APPLICATION MAP, CATEGORY DETAIL, FILE LEDGER) in it.\n` +
    `- Cite the exact finding titles you relied on in citedFindings.\n` +
    `- The four starter questions always map to review sections — never decline them as uncovered: ` +
    `"Is this app actually finished?" → the verdict and completeness score; ` +
    `"What's the biggest risk?" → the highest-severity liabilities; ` +
    `"Is the login and authentication real?" → the Authentication bucket (its score, evidence, and what the scan found); ` +
    `"What should be fixed first?" → the liabilities ordered by severity. ` +
    `"What still needs verifying?" → the NEEDS VERIFICATION section below the liabilities.\n` +
    `- Items in the NEEDS VERIFICATION section were flagged by the scan but NOT established — the review could not verify ` +
    `them from the code. NEVER state one as an established fact, a liability, or something the app does or lacks. ` +
    `Describe each only as flagged and awaiting developer confirmation, and say what would settle it (the "how a developer checks it" line).\n` +
    `- "Is X real?" means "what did the review establish about X's implementation?" — answer from the category's score ` +
    `and evidence (e.g. "the review found sign-in code with no backend, scoring it 2/10"), never from certainty the review doesn't claim.\n` +
    `- The "scan evidence" lines under each bucket item are the raw scan signals for your precision — use them to ` +
    `name specifics in plain words (e.g. "the payments code"). Quote raw file paths or line numbers ONLY when the stakeholder ` +
    `explicitly asks for them.\n` +
    `- If the review flags the area but lacks the specific detail asked for, set insufficientContext to true and ` +
    `declineTier to "partial": write what the review DID establish using ONLY related cited findings — never invent the missing analysis. ` +
    `${PARTIAL_SCOPE_GUIDANCE}\n` +
    `- If the question can only be answered by watching the app run (load, real users, production data, third-party outages), ` +
    `set insufficientContext to true and declineTier to "runtime".\n` +
    `- If nothing in the review bears on the question, set insufficientContext to true and declineTier to "unknown". ` +
    `The review includes the warehouse detail below the buckets (APPLICATION MAP, CATEGORY DETAIL, FILE LEDGER) — check ALL of it ` +
    `before deciding nothing bears on the question. If any part of the review establishes part of an answer, use the "partial" ` +
    `tier instead: answer with the part the review establishes and state the limit, rather than declining outright.\n` +
    `- NEVER give cost, time, or effort estimates — no hours, prices, timelines, or t-shirt sizes.\n` +
    `- NEVER invent findings, files, or numbers that are not in the review.\n\n` +
    `THE REVIEW:\n${context}`
  );
}

// Double-check for unknown-tier declines only (investor package only —
// this route is the only FinalRead ask path; the consumer tier has no
// Q&A). When the first model says nothing bears on the question, one
// verification call goes to the OTHER model in the premium chain with an
// explicit both-ways term-expansion instruction. One attempt, no retry
// loop. The first call was a decline, so it was never charged; a
// verification answer that passes the caller's citation check is charged
// exactly once, like a normal answer. If the verification call fails,
// errors, or can't run, the caller keeps the original decline WITHOUT the
// double-checked marking — the check did not complete.
type VerificationOutcome =
  | {
      kind: "answer";
      parsed: {
        answer: string;
        citedFindings: string[];
        insufficientContext: boolean;
        declineTier: string;
      };
      lastResponse: any;
      modelName: string;
      partialPrefix: boolean;
    }
  | { kind: "decline"; answer: string };

async function verifyUnknownDecline(
  question: string,
  report: FinalReadReport,
  firstModelName: string
): Promise<VerificationOutcome> {
  const verifyModel = pickVerificationModel(
    firstModelName === CLAUDE_SONNET_MODEL,
    isClaudeConfigured()
  );
  if (!verifyModel) {
    log.warn("finalread/ask double-check skipped: other premium model unavailable");
    return { kind: "decline", answer: formatUnknownDecline(false) };
  }
  try {
    const contents = doubleCheckPrompt(buildQaContext(report, question), question);
    const config: GenerateContentConfig = {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: ANSWER_SCHEMA,
    };
    let raw: string;
    let resp: any;
    let vModel: string;
    if (verifyModel === "claude") {
      const claude = await generateWithClaude({ contents, config }, CLAUDE_SONNET_MODEL);
      raw = (claude.text || "").trim();
      resp = claude;
      vModel = CLAUDE_SONNET_MODEL;
    } else {
      const gen = await ai.models.generateContent({
        model: PRIMARY_MODEL,
        contents,
        config,
      });
      raw = String((gen as any).text || "").trim();
      resp = gen;
      vModel = PRIMARY_MODEL;
    }
    const candidate = JSON.parse(raw);
    const answer = String(candidate.answer || "").trim();
    const cited = Array.isArray(candidate.citedFindings)
      ? candidate.citedFindings.map((c: any) => String(c))
      : [];
    const declined =
      candidate.insufficientContext === true ||
      candidate.insufficientContext === "true" ||
      candidate.insufficientContext === 1;
    if (!declined && answer) {
      // Grounded answer. Citations are NOT validated here — the caller
      // runs the same 4b check as for a first-model answer, so a
      // verification answer with invented citations still declines free.
      return {
        kind: "answer",
        parsed: {
          answer,
          citedFindings: cited,
          insufficientContext: false,
          declineTier: normalizeDeclineTier(candidate.declineTier),
        },
        lastResponse: resp,
        modelName: vModel,
        partialPrefix: false,
      };
    }
    if (declined) {
      const tier = normalizeDeclineTier(candidate.declineTier);
      if (
        tier === "partial" &&
        answer &&
        unknownCitations(cited, report).length === 0
      ) {
        return {
          kind: "answer",
          parsed: {
            answer,
            citedFindings: cited,
            insufficientContext: true,
            declineTier: "partial",
          },
          lastResponse: resp,
          modelName: vModel,
          partialPrefix: true,
        };
      }
      if (tier === "runtime") {
        return { kind: "decline", answer: RUNTIME_DECLINE_REPLY };
      }
      // Unknown (or ungrounded partial): both models agree nothing
      // grounded bears on the question.
      return { kind: "decline", answer: formatUnknownDecline(true) };
    }
    log.warn("finalread/ask double-check: empty answer without decline");
    return { kind: "decline", answer: formatUnknownDecline(false) };
  } catch (err: any) {
    log.warn(`finalread/ask double-check failed: ${err?.message || err}`);
    return { kind: "decline", answer: formatUnknownDecline(false) };
  }
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

    // 2c. Runtime questions: deterministic classification — the model has
    // shown it can't route these itself (it once answered "what happens if
    // my server goes down" with the previous question's line numbers).
    // Fixed reply, no model call, no charge. Same response shape as the
    // model's own runtime tier (4a) so the client needs no new handling.
    if (isRuntimeQuestion(question)) {
      return res.json({
        declined: true,
        answer: RUNTIME_DECLINE_REPLY,
        citedFindings: [],
        runtime: true,
      });
    }

    // 3. Grounded model call with retries. Failed attempts are never charged.
    // The question rides into the context so question-matching warehouse
    // lines survive the runaway ceiling ahead of unrelated lines.
    const prompt = systemPrompt(buildQaContext(report, question));
    let parsed: any = null;
    let lastResponse: any = null;
    let modelName = "";
    for (let attempt = 1; attempt <= 3 && !parsed; attempt++) {
      try {
        const gen = await generateWithFallback(
          {
            contents: `${prompt}\n\nQUESTION: ${question.trim()}`,
            config: {
              temperature: 0.3,
              responseMimeType: "application/json",
              responseSchema: ANSWER_SCHEMA,
            },
          },
          undefined,
          // FinalRead is the premium tier: on a Gemini failure it falls back
          // to Claude Sonnet, never to the consumer lite model.
          { tier: "premium" }
        );
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
    // - unknown: nothing in the review bears on it. One double-check call
    //   to the other premium model first; if it agrees, the flat decline
    //   marked as double-checked, plus the free-decline rephrase note.
    //   Ungrounded partials share the flat-decline path (free, so the note
    //   claim stays true) but never trigger the double-check.
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
      } else if (parsed.declineTier === "unknown") {
        const outcome = await verifyUnknownDecline(question, report, modelName);
        if (outcome.kind === "answer") {
          parsed = outcome.parsed;
          lastResponse = outcome.lastResponse;
          modelName = outcome.modelName;
          if (outcome.partialPrefix) {
            parsed.answer = PARTIAL_DECLINE_PREFIX + parsed.answer;
          }
          // Falls through to 4b (citation check) and 5 (charge once).
        } else {
          return res.json({
            declined: true,
            answer: outcome.answer,
            citedFindings: [],
          });
        }
      } else {
        return res.json({
          declined: true,
          answer: formatUnknownDecline(false),
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
        answer: formatUncitedDecline(),
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
