// Gemini-backed generation routes: heal, audit, and the SSE stream.
import { Router } from "express";
import { asyncRoute } from "../async-route";
import {
  ai,
  formatGeminiError,
  generateWithFallback,
  generateStreamWithFallback,
  extractUsage,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
} from "../gemini";
import { log } from "../logger";
import { requireAuth, requireCredits, AuthedRequest } from "../middleware/requireAuth";
import { chargeForCall } from "../credits";
import { getWorkspaceFile, listWorkspaceFiles } from "../workspace-store";
import { verifySuggestedFix } from "../fix-verify";
import { verifyHealedCode, hasActualCode } from "../fix-verify";

const router = Router();

// 3.5. Heal truncated or interrupted code
router.post("/api/heal", requireAuth, requireCredits("heal"), asyncRoute(async (req: AuthedRequest, res) => {
  const { code, prompt } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Code content is required for healing" });
  }
  // Refuse comment-only input before any model call or charge. The ZIP-upload
  // flow leaves a status message in the editor ("Custom ZIP Codebase Loaded
  // Successfully!..."); there is no code to heal, and the model would treat
  // the message as a prompt to generate a new app.
  if (!hasActualCode(code)) {
    return res.status(400).json({ error: "There's no code to heal — the editor holds a status message, not source code. No credits were charged." });
  }

  try {
    const systemInstruction = `You are a code completion specialist. Your sole task is to complete truncated React TypeScript code.

CRITICAL: Your output MUST be the input code below, healed and completed. Do NOT generate a new application. Do NOT output example, template, demo, or mockup code. Do NOT invent a different app, even one with a similar name or purpose. Complete the EXACT code provided.

You will receive the partial/truncated code, and the original prompt describing the app.
You must:
1. Read the incomplete code carefully.
2. Analyze the unclosed curly braces, brackets, imports, or statements.
3. Complete and heal the code, ensuring all open structures are properly closed and any missing elements (like returning JSX elements or adding 'export default function App()') are appended correctly.
4. Keep all existing variables, components, names, and logic intact. Do not rewrite from scratch. Do not rename anything. Do not change what the app does.
5. Return ONLY the fully-compiled, 100% syntactically correct, healed React TypeScript TSX code.
6. Do NOT wrap the response in markdown code blocks like \`\`\`tsx. Return only the raw text of the complete, valid React file.`;

    const healingPrompt = `Original App Goal: "${prompt || "Simple functional React widget"}"
Truncated Incomplete Code:
${code}`;

    const { response: healedResponse, modelName } = await generateWithFallback({
      contents: healingPrompt,
      config: {
        systemInstruction,
        temperature: 0.2, // Low temperature for high precision code healing
      },
    });
    let healedCode = healedResponse.text || "";

    // Clean up code formatting tags if the model ignored instructions
    if (healedCode.startsWith("```")) {
      const lines = healedCode.split("\n");
      if (lines[0].startsWith("```")) {
        lines.shift();
      }
      if (lines[lines.length - 1].startsWith("```")) {
        lines.pop();
      }
      healedCode = lines.join("\n");
    }
    healedCode = healedCode.trim();

    if (!healedCode) {
      const finishReason = (healedResponse as any)?.candidates?.[0]?.finishReason;
      if (finishReason === "SAFETY") {
        throw new Error("The AI's safety filters blocked this content, so no healed code could be returned. No credits were charged.");
      }
      throw new Error("The AI returned an empty response, so the heal could not complete. No credits were charged — please try again.");
    }

    // Deterministic guard: the healed output must actually contain the input
    // code. Without this, the model can return a brand-new demo app instead
    // of healing (seen once: a "VibeCoder Codebase Auditor" mockup). Reject
    // before charging — a hallucinated heal is not a delivered heal.
    const healCheck = verifyHealedCode(code, healedCode);
    if (!healCheck.passed) {
      log.warn(`Heal verification failed: ${healCheck.reason} (input ${code.length} chars, output ${healedCode.length} chars)`);
      throw new Error(healCheck.reason);
    }

    const chargedBalance = await chargeForCall(req.user!.id, extractUsage(healedResponse), modelName, "ai heal");
    if (chargedBalance != null) res.set("X-Credits-Balance", String(chargedBalance));

    res.json({ healedCode });
  } catch (error: any) {
    log.error("Healing API Error:", error);
    res.status(500).json({ error: formatGeminiError(error) });
  }
}));

// 3.6. Suggested fix for a single audit finding. REVIEW ONLY: the model
// proposes a remediation as a dev-handoff packet; nothing is applied to the
// user's code. Follows the /api/heal pattern, including the rule that an
// empty or unusable model response throws BEFORE chargeForCall runs.
router.post("/api/suggest-fix", requireAuth, requireCredits("suggestFix"), asyncRoute(async (req: AuthedRequest, res) => {
  const { file, line, message, severity, type, suggestion, codeContext } = req.body || {};
  if (!message || !file) {
    return res.status(400).json({ error: "A finding message and file are required to suggest a fix" });
  }

  try {
    const systemInstruction = `You are a senior code-remediation specialist writing a developer handoff packet.
A static analyzer flagged one finding in a codebase. Your job is to explain it in plain English and propose a concrete code fix for a developer to REVIEW. You do not apply the fix; you only suggest it.

You must return ONLY a JSON object with exactly these keys:
{
  "plainEnglishIssue": "1-3 sentences a non-engineer could understand: what is wrong and what could go wrong if it is ignored.",
  "evidence": "The file:line reference plus the relevant code snippet showing the problem.",
  "remediationDiff": "A unified diff, or clearly labeled BEFORE and AFTER code blocks, showing the suggested fix. Show the smallest change that addresses the finding — do not rewrite the whole file.",
  "verificationSteps": ["Ordered, concrete steps a developer can run to confirm the fix works (commands, tests, or manual checks)."],
  "insufficientContext": false
}

Hard rules:
- Output raw JSON only. No markdown fences, no prose before or after the JSON.
- NEVER include effort estimates: no hours, no story points, no t-shirt sizes, no "easy", "hard", or "trivial", no timelines.
- If the finding looks like a false positive or cannot be fixed in code, say so in plainEnglishIssue and explain why instead of inventing a diff.
- NEVER invent code you have not seen: no made-up route paths, handler names, file names, imports, or middleware. If the provided code context does not show the actual flagged code — for example no snippet is shown — do NOT write a diff. Set "insufficientContext" to true, leave "remediationDiff" empty, and use "plainEnglishIssue" to state exactly what context is missing. When the finding is file-level (flagged at line 1) and the full file content is provided, locate the flagged construct yourself by matching the finding's description (e.g. a DELETE/PUT/PATCH handler missing auth) against the file before deciding context is insufficient.
- If the fix references a symbol, import, or middleware that is not visible in the provided code context, say so explicitly in the remediation (e.g. "assumes requireAuth is already imported in this file — add the import if it is not") instead of silently assuming it exists.
- For missing-authentication findings: adding an auth middleware is NOT enough if the handler still reads the user identity from the request body or query string. A userId taken from req.body / req.query is untrusted input — any logged-in user could pass someone else's ID (broken object-level authorization). The fix must derive the caller's identity from the verified token or session (e.g. req.user, supabase.auth.getUser(), the decoded JWT subject) and ignore any userId in the body. If the code context does not show how identity is established, say so instead of guessing.
- If the fix changes the API contract (new required header, removed body param), add one explicit line naming what frontend callers must change (e.g. "Callers in Dashboard.tsx must now send Authorization: Bearer <token>; remove userId from the request body").
- The audience is a developer who will review this suggestion, not a machine applying it.`;

    // Prefer the real file from the user's workspace over the scanner's snippet,
    // so the model patches actual code instead of inventing routes/handlers.
    // Falls back to the scanner-provided snippet when the file isn't stored.
    let effectiveContext = codeContext || "";
    let workspaceFileFound = false;
    try {
      const wanted = String(file);
      let row = await getWorkspaceFile(req.user!.id, wanted);
      if (!row) {
        // The finding's path may be a suffix of the stored path
        // ("server.ts" vs "SecureToken-AI-main/server.ts"). A single
        // unambiguous suffix match is the same file; several matches is a
        // guess, so fall back to the snippet instead.
        const suffix = "/" + wanted.replace(/^\/+/, "");
        const matches = (await listWorkspaceFiles(req.user!.id)).filter(
          (f) => f.path === wanted || f.path.endsWith(suffix)
        );
        if (matches.length === 1) row = matches[0];
      }
      workspaceFileFound = !!row?.content;
      const content = row?.content || "";
      if (content) {
        const allLines = content.split("\n");
        const flagged = Number(line);
        if (line != null && Number.isFinite(flagged) && flagged >= 1) {
          const idx = Math.min(flagged, allLines.length) - 1;
          let start: number, end: number, markedLine: number;
          if (flagged === 1 && allLines.length <= 300) {
            // File-level finding (flagged at line 1): the offending
            // construct can be anywhere in the file — e.g. a destructive
            // handler at line 120 of a 164-line route file. An 81-line
            // window anchored at line 1 misses it and the model declines
            // for lack of context. Send the whole file so the model can
            // locate the flagged code itself.
            start = 0;
            end = allLines.length;
            markedLine = 1;
          } else {
            start = Math.max(0, idx - 40);
            end = Math.min(allLines.length, idx + 41);
            markedLine = flagged;
          }
          const numbered = allLines
            .slice(start, end)
            .map((l, i) => `${start + i + 1 === markedLine ? ">>> " : "    "}${start + i + 1}: ${l}`)
            .join("\n");
          effectiveContext =
            `Actual file content of ${file} (lines ${start + 1}-${end} of ${allLines.length}; flagged line marked >>>):\n${numbered}`;
        } else {
          effectiveContext = `Actual file content of ${file} (first 8000 characters):\n${content.slice(0, 8000)}`;
        }
      }
    } catch {
      // Fall back to the scanner-provided snippet.
    }

    const fixPrompt = `Finding type: "${type || "unknown"}"
Severity: ${severity || "unknown"}
File: ${file}${line != null ? `, line ${line}` : ""}
Finding message: "${message}"${suggestion ? `\nScanner's own recommendation: "${suggestion}"` : ""}
Code context:
${effectiveContext || "(no code context available)"}`;

    // Generate + parse with server-side retry. A malformed model response is
    // retried automatically (up to 3 attempts) before the user ever sees an
    // error — failed attempts are never charged, so the retry costs nothing.
    // With responseSchema the JSON should always parse; the retry covers
    // truncation and transient model issues.
    let parsed: any = null;
    let fixResponse: any = null;
    let modelName = "";
    let lastRaw = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const gen = await generateWithFallback({
        contents: fixPrompt,
        config: {
          systemInstruction,
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              plainEnglishIssue: { type: "string" },
              evidence: { type: "string" },
              remediationDiff: { type: "string" },
              verificationSteps: { type: "array", items: { type: "string" } },
              insufficientContext: { type: "boolean" },
            },
            required: [
              "plainEnglishIssue",
              "evidence",
              "remediationDiff",
              "verificationSteps",
              "insufficientContext",
            ],
          } as any,
        },
      });
      fixResponse = gen.response;
      modelName = gen.modelName;
      let raw = fixResponse.text || "";
      lastRaw = raw;

      // Clean up code fencing if the model ignored the raw-JSON instruction
      if (raw.trimStart().startsWith("```")) {
        const lines = raw.split("\n");
        if (lines[0].trimStart().startsWith("```")) {
          lines.shift();
        }
        while (lines.length && lines[lines.length - 1].trim() === "```") {
          lines.pop();
        }
        if (lines.length && lines[lines.length - 1].trimStart().startsWith("```")) {
          lines.pop();
        }
        raw = lines.join("\n");
      }
      raw = raw.trim();

      if (!raw) {
        const finishReason = (fixResponse as any)?.candidates?.[0]?.finishReason;
        if (finishReason === "SAFETY") {
          throw new Error("The AI's safety filters blocked this content, so no suggested fix could be returned. No credits were charged.");
        }
        log.warn(`Suggest-fix attempt ${attempt}: empty response (finishReason=${finishReason || "unknown"})`);
        continue;
      }

      try {
        parsed = JSON.parse(raw);
      } catch {
        const finishReason = (fixResponse as any)?.candidates?.[0]?.finishReason;
        // Log the raw response and stop reason so a parse failure becomes a
        // fact (truncation vs formatting) instead of a guess.
        log.warn(
          `Suggest-fix attempt ${attempt}: JSON parse failed (finishReason=${finishReason || "unknown"}, ` +
            `len=${raw.length}, tail=${JSON.stringify(raw.slice(-120))})`
        );
        continue;
      }

      // Validate completeness inside the retry loop: a valid-JSON response
      // with empty fields (no explanation, or no diff without a decline) is
      // a transient model failure like any other — retry it, don't surface
      // it. Log which fields were empty so the failure mode stays visible.
      const insufficientRaw = (parsed as any).insufficientContext;
      const insufficientCheck =
        insufficientRaw === true || insufficientRaw === "true" || insufficientRaw === 1;
      const issueCheck = String((parsed as any).plainEnglishIssue || "").trim();
      const diffCheck = insufficientCheck
        ? "n/a (declined)"
        : String((parsed as any).remediationDiff || "").trim();
      if (!issueCheck || (!insufficientCheck && !diffCheck)) {
        log.warn(
          `Suggest-fix attempt ${attempt}: incomplete JSON (insufficientContext=${JSON.stringify(insufficientRaw)}, ` +
            `hasIssue=${!!issueCheck}, hasDiff=${!!diffCheck && diffCheck !== "n/a (declined)"}, ` +
            `len=${raw.length}, tail=${JSON.stringify(raw.slice(-120))})`
        );
        parsed = null;
        continue;
      }
      break;
    }

    if (!parsed) {
      throw new Error("The AI returned a response that could not be read as a fix suggestion. No credits were charged — please try again.");
    }

    const stepsRaw = parsed.verificationSteps;
    const verificationSteps = Array.isArray(stepsRaw)
      ? stepsRaw.map((s: any) => String(s)).filter((s: string) => s.trim())
      : typeof stepsRaw === "string" && stepsRaw.trim()
        ? [stepsRaw.trim()]
        : [];
    // Lenient coercion: the schema says boolean, but a truthy string/"1"
    // from the model is still a decline, not a broken response.
    const insufficientRaw = parsed.insufficientContext;
    const insufficient =
      insufficientRaw === true || insufficientRaw === "true" || insufficientRaw === 1;
    const fix = {
      plainEnglishIssue: String(parsed.plainEnglishIssue || "").trim(),
      evidence: String(parsed.evidence || "").trim(),
      remediationDiff: insufficient ? "" : String(parsed.remediationDiff || "").trim(),
      verificationSteps,
    };
    // Completeness was already validated inside the retry loop; a parsed
    // response reaching here has an explanation and (unless it declined) a
    // diff. This is a final invariant, not a user-facing branch.

    if (insufficient) {
      // An honest "I can't see the code" is not a delivered fix: no charge.
      // workspaceFileFound tells the client whether the "add the file to the
      // workspace" hint applies — the file is often already there and the
      // flagged section was truncated or unlocatable instead.
      return res.json({ suggestion: fix, insufficientContext: true, workspaceFileFound });
    }

    const fixBalance = await chargeForCall(req.user!.id, extractUsage(fixResponse), modelName, "ai suggest-fix");
    if (fixBalance != null) res.set("X-Credits-Balance", String(fixBalance));

    // Deterministic post-check: verify the suggested AFTER code actually
    // addresses the finding. Prompt rules alone produced a fix that added
    // requireAuth while still trusting req.body userId — this catches that
    // class of failure and surfaces it to the reviewer.
    const fixVerification = verifySuggestedFix(fix.remediationDiff, {
      probe: String(req.body?.type || ""),
      title: String(message || ""),
    });

    res.json({ suggestion: fix, fixVerification });
  } catch (error: any) {
    log.error("Suggest-fix API Error:", error);
    res.status(500).json({ error: formatGeminiError(error) });
  }
}));

// 3.8. Objective post-generation code auditor (Cold, Unbiased Review)
router.post("/api/audit", requireAuth, requireCredits("audit"), asyncRoute(async (req: AuthedRequest, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Code is required for auditing" });
  }

  try {
    const systemInstruction = `You are VibeCoder Code Auditor, an elite, completely objective React software inspector. 
Your sole task is to analyze the provided React/TypeScript source code with ABSOLUTELY NO memory, bias, or assumptions from what the user originally requested. You must ignore any assumptions of perfection.
You did NOT write this code and have absolutely NO knowledge or prior memory of any user intent, user prompt, requested specification, or conversation that produced this code. You must perform a 100% "cold read" and evaluate only what is actually written on the page.

Instead, read and convey ONLY what is actually written in the code in clear, highly detailed English terms.

CRITICAL WARNING AGAINST MATHEMATICAL GLORIFICATION & HALLUCINATION:
You MUST NEVER assume or claim high-level scientific, algorithmic, audio synthesis, or mathematical sophistication unless you see actual detailed equations or complex multi-node/custom logic coded explicitly in the file.
- Do NOT describe simple handlers, mock elements, or basic helper utilities as "sophisticated algorithms", "complex filters", or "highly advanced systems."
- If you see a Web Audio API implementation, look at the actual code blocks: if it is standard White Noise (e.g. via Math.random()), simple BiquadFilterNode configurations, basic setInterval volume tick adjustments, or simple single/dual oscillator beeps, you MUST describe them exactly as such: "simple, naive white-noise generation and basic volume ticking."
- NEVER invent or romanticize technical details. Do not claim there are "pink or brown noise buffers", "LFO sine-wave modulators at 0.12Hz", "exponential decay impulse curves", or "orchestrated major chord harmonies" unless you see the actual mathematical logic, LFO nodes, custom decay buffers, or multi-node chords explicitly defined in the source code.
- If the code is basic, call it "basic", "naive", or "rudimentary". Truth, accuracy, and extreme objectivity are absolute.

CRITICAL WARNING AGAINST "COMMENT-ECHOING" AND "HEAL INCOMPLETE CODE" HALLUCINATIONS:
- You MUST NOT trust, echo, or source [SUCCESS] findings, fully functional features, or claim checks from developer comments, headers, or intended descriptions in the code (e.g. "// Trigger post-generation objective code audit...", "// Integrates with backend db", or "// Implement user authentication here").
- A comment is NOT code. You are strictly forbidden from reporting a feature as a fully functional active feature or verifying a claim check as true unless the ACTUAL executable JavaScript/TypeScript code implementing that feature is fully written and present in this specific file.
- If a feature is described in a comment but the actual code to perform that feature is missing, stubbed, or calling a mock/non-existent endpoint, you MUST mark it as a gap/placeholder under the "⚠️ PLACEHOLDERS, GAPS, & MISSING LOGIC" header, with a clear explanation: "The comment claims to implement X, but the actual logic is missing or stubbed."
- Never assume an external route/API (like "/api/audit", "/api/projects") actually performs secure operations unless you see the backend code itself. If you only see a client-side fetch() call to a backend endpoint, state exactly what you see: "The client fetches from /api/X, but the backend implementation is external to this file and cannot be verified." Do NOT assume or claim the endpoint is "fully isolated", "unbiased", or "fully secure."

CRITICAL PRINCIPLE: SEPARATE BOILERPLATE SHELL FROM FUNCTIONAL BUSINESS LOGIC
You must never grade code completeness on a curve just because the UI renders, styles are pretty, and basic CRUD/localstorage functions do not crash. You must critically separate:
1. **The Shell / Boilerplate (Max 50% of the app's completeness)**: Visual layout, CSS styling, responsive HTML elements, simple state handlers (add/remove list items), modal wrappers, and localStorage getters/setters.
2. **The Core Business Logic & Core Algorithms (Remaining 50% of the app's completeness)**: The actual functional backbone of the application. This includes mathematical modeling (e.g. interest forecasting, payment calculations), alert schedulers/daemons, complex control branches, and actual data-processing algorithms.
If the core algorithms or mathematical models are stubbed out, mocked with hardcoded static variables (e.g. constant state values), or completely missing, the codebase is at MOST 50% complete. Be absolutely brutal, honest, and objective about this.

Structure your audit strictly into these clear headers:
# 📊 AUDIT: CODEBASE COMPLETENESS & OBJECTIVE HEALTH CHECK
Calculate a strict "Estimated Completeness Score" from 0% to 100% using the above formula:
- **UI Shell & Boilerplate** (visual tables, basic CRUD states, simple inputs, localStorage): Worth up to 50% max.
- **Core Business Logic, Mathematical Models & Algorithms** (actual forecasting engines, calculations, active schedulers, formula implementations): Worth up to 50%.
Explain the score in detail. Call out if the core math or backend simulation logic is missing or mocked.

# 🛠️ FULLY FUNCTIONAL ACTIVE FEATURES
(List the parts of the code that are fully coded, interactive, and completely implemented. Label them as "Boilerplate/Shell UI" or "Core Business Logic".)

# ⚠️ PLACEHOLDERS, GAPS, & MISSING LOGIC
(List every empty function, commented-out section, hardcoded mock placeholder, or missing mathematical modeling. Provide line numbers and explain exactly what logic needs to go there to make it fully functional rather than just a shell.)

# 🧩 REACTIVE ANATOMY & ACTIVE MAPPING
- **States & Hooks**: Describe each active useState/useEffect and its exact real-world function.
- **Core Event Handlers**: Describe each active handler function and what it actually changes in the state.

Return your response in standard Markdown format. Keep it concise, professional, and targeted to helping a vibe developer inspect the exact state of the app.`;

    // Pre-process code by numbering lines to ensure line-number accuracy during the audit
    const numberedCode = code.split("\n").map((line: string, i: number) => `${i + 1}\t${line}`).join("\n");

    const auditPrompt = `Perform a 100% cold-read, unbiased, and objective code audit on this React/TypeScript codebase.
You have no prior knowledge of what this application is supposed to do. Cite exact line numbers.

${numberedCode}`;

    // The validation pass below reuses whichever model answered the audit.
    const { response: auditResponse, modelName } = await generateWithFallback({
      contents: auditPrompt,
      config: {
        systemInstruction,
        temperature: 0.1, // Low temperature for maximum precision and zero bias
      },
    });
    let auditBalance: number | null = await chargeForCall(req.user!.id, extractUsage(auditResponse), modelName, "ai audit pass 1");

    const rawAuditText = auditResponse.text || "";
    let validatedAuditText = rawAuditText;

    try {
      const validationSystemInstruction = `You are an elite Audit Reconciliation & Consistency Validator.
Your sole task is to analyze the provided React/TypeScript source code and the generated Markdown code audit report, identify any internal contradictions, overconfidence, or consistency failures, reconcile them, and return the corrected Markdown audit report.

CRITICAL RECONCILIATION RULES:
1. **No Perfect Score with Risks or Gaps**: If the audit report lists any warning, risk, placeholder, or gap, the "Estimated Completeness Score" CANNOT be 100%. If the score is written as 100% but there are any risks, limitations, or gaps mentioned, you MUST reduce the score in the Markdown text (e.g., to 95%, 90%, 80%, etc.) to reflect these limitations.
2. **Reconcile Gaps Section**: If the report describes any potential risk, bypass vector, or missing logic in the text, but the "# ⚠️ PLACEHOLDERS, GAPS, & MISSING LOGIC" section is empty or says "None" or "No code gaps", you MUST add entries to that section detailing those findings and reduce the completeness score accordingly.
3. **Keep Same Headers**: Your output must strictly preserve the structure and format of the original Markdown headers:
# 📊 AUDIT: CODEBASE COMPLETENESS & OBJECTIVE HEALTH CHECK
# 🛠️ FULLY FUNCTIONAL ACTIVE FEATURES
# ⚠️ PLACEHOLDERS, GAPS, & MISSING LOGIC
# 🧩 REACTIVE ANATOMY & ACTIVE MAPPING

Return ONLY the corrected Markdown text. Do not output any notes, chat, or meta-explanations.`;

      const validationPrompt = `Source Code:
${numberedCode}

Generated Markdown Audit:
${rawAuditText}

Identify any contradictions between findings, gaps, and the completeness score in the Markdown audit. Reconcile them completely and output the final, corrected Markdown.`;

      const validationResponse = await ai.models.generateContent({
        model: modelName,
        contents: validationPrompt,
        config: {
          systemInstruction: validationSystemInstruction,
          temperature: 0.1,
        },
      });

      if (validationResponse && validationResponse.text) {
        validatedAuditText = validationResponse.text.trim();
        const validationBalance = await chargeForCall(req.user!.id, extractUsage(validationResponse), modelName, "ai audit validation pass");
        if (validationBalance != null) auditBalance = validationBalance;
      }
    } catch (validationErr) {
      log.warn("Audit Markdown Validation Pass Error (falling back to original):", validationErr);
    }

    // --- FINAL LAYER: DETERMINISTIC MARKDOWN RECONCILIATION & CONSISTENCY SAFEGARD ---
    try {
      const scoreMatch = validatedAuditText.match(/Estimated Completeness Score:\s*(\d+)%/i) 
                         || validatedAuditText.match(/(\d+)%\s*completeness/i)
                         || validatedAuditText.match(/Completeness Score:\s*(\d+)%/i);

      if (scoreMatch) {
        let score = parseInt(scoreMatch[1], 10);
        
        const hasGapsSection = /#+ ⚠️\s*(PLACEHOLDERS|GAPS|MISSING LOGIC)/i.test(validatedAuditText);
        let hasGapsContent = false;
        if (hasGapsSection) {
          const gapsSectionMatch = validatedAuditText.match(/#+ ⚠️\s*(PLACEHOLDERS|GAPS|MISSING LOGIC)[\s\S]*?(?=#+|$)/i);
          if (gapsSectionMatch) {
            const lines = gapsSectionMatch[0].split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if ((trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed)) && 
                  !/none|no gaps|no placeholders|n\/a/i.test(trimmed)) {
                hasGapsContent = true;
                break;
              }
            }
          }
        }

        const hasRisksOrBypasses = /risk|warning|bypass|limitation|contradiction/i.test(validatedAuditText) &&
                                  !/no risk|no warning|no bypass|no limitation/i.test(validatedAuditText);

        if (score >= 100 && (hasGapsContent || hasRisksOrBypasses)) {
          const originalBlock = scoreMatch[0];
          const replacedBlock = originalBlock.replace("100", "90");
          validatedAuditText = validatedAuditText.replace(originalBlock, replacedBlock);
        }
      }
    } catch (markdownReconcileErr) {
      log.error("Markdown Reconciler Error:", markdownReconcileErr);
    }

    if (auditBalance != null) res.set("X-Credits-Balance", String(auditBalance));
    res.json({ audit: validatedAuditText });
  } catch (error: any) {
    log.error("Auditing API Error:", error);
    res.status(500).json({ error: formatGeminiError(error) });
  }
}));

// 3.9. Isolated "cold read" structured code auditor

// 4. Stream code and description from Gemini
router.post("/api/generate", requireAuth, requireCredits("generate"), asyncRoute(async (req: AuthedRequest, res) => {
  const { prompt, existingCode, systemInstruction: customSystemInstruction } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  // Set standard Server-Sent Events headers for SSE streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const defaultSystemInstruction = existingCode && typeof existingCode === "string" && existingCode.trim().length > 0
      ? `You are VibeCoder, an elite AI software architect performing INCREMENTAL CODE EVOLUTION and FEATURE REFINEMENT.
The user has provided an existing React/TypeScript codebase AND a refinement instruction.
Your task is to EVOLVE, ENHANCE, and BUILD UPON the existing code according to the user's refinement prompt (e.g., adding new features, state hooks, tabs, handlers, sub-components, or layout improvements) WITHOUT discarding or destroying existing working logic unless specifically asked to remove or replace it.

=== EXISTING CODEBASE TO EVOLVE ===
${existingCode}
===================================

You MUST format your output EXACTLY as follows. Do not include introductory text, conversational chatter, or conclusions. Start immediately with ====CODE====.

====CODE====
Provide the complete, updated 100% executable React component code containing all evolved features.
- Write modern, elegant TypeScript.
- Import standard React hooks at the top.
- Import any required icons from 'lucide-react'.
- Use Tailwind CSS classes for styling. No CSS imports or styles attribute unless necessary.
- It must be fully self-contained and export a default function App().
- Do NOT include markdown code block wrappers (like \`\`\`typescript) inside the ====CODE==== section - output the raw text directly.

====PURPOSE====
Provide a structural mapping of the evolved codebase. Include:
1. **Evolution Summary**: What new features, state hooks, and handlers were added or refined in this iteration.
2. **Architecture Overview**: The overall layout design and structural components.
3. **State & Hooks**: Clear explanation of all active state variables.
4. **Core Functions**: List of key functions and handlers.
5. **Visual & Styling Decisions**: Design rationale for the UI layout.

Do not skip sections, and make sure the code is completely written (no comments like '// Rest of code goes here').`
      : `You are VibeCoder, a elite, hyper-focused AI software architect. Based on the user's request, you will generate a single-file, beautifully styled, production-ready React component (using Tailwind CSS, lucide-react icons, and standard React hooks) and a detailed structural breakdown explaining the exact purpose of each function, hook, state, and visual component.

You must be structured, literal, and detailed. Your explanation should help a "vibe coder" understand how the entire codebase fits together, with clean, professional, and accessible layouts.

You MUST format your output EXACTLY as follows. Do not include introductory text, conversational chatter, or conclusions. Start immediately with ====CODE====.

====CODE====
Provide the complete, 100% executable React component code.
- Write modern, elegant TypeScript.
- Import standard React hooks at the top.
- Import any required icons from 'lucide-react' (e.g. \`import { ArrowLeft, Check } from 'lucide-react'\`).
- Use Tailwind CSS classes for styling. No CSS imports or styles attribute unless necessary.
- It must be fully self-contained.
- Do NOT include markdown code block wrappers (like \`\`\`typescript) inside the ====CODE==== section - output the raw text directly.
- The file MUST export a default function App().

====PURPOSE====
Provide a structural mapping of the codebase. Include:
1. **Architecture Overview**: The layout design and structural components.
2. **State & Hooks**: Clear explanation of each state variable (e.g. useState, useEffect), why it exists, and what it triggers.
3. **Core Functions**: List every function (e.g. event handlers, helper math), its purpose, and parameters.
4. **Visual & Styling Decisions**: Why certain spacing, layouts (bento grids, flex boxes), and color schemes were used.

Do not skip sections, and make sure the code is completely written (no comments like '// Rest of code goes here').`;

    const systemInstruction = customSystemInstruction || defaultSystemInstruction;

    // Let the client know when we hit a model busy state and fall back seamlessly
    const { stream, modelName } = await generateStreamWithFallback(
      {
        contents: prompt,
        config: {
          systemInstruction,
          temperature: 0.7,
        },
      },
      () => {
        res.write(`data: ${JSON.stringify({ warning: `The primary model (${PRIMARY_MODEL}) is currently experiencing high demand. Seamlessly falling back to ${FALLBACK_MODEL}...` })}\n\n`);
      }
    );

    let streamUsage = { inputTokens: 0, outputTokens: 0 };
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
      // usageMetadata typically arrives on the final chunk.
      const u = extractUsage(chunk);
      streamUsage.inputTokens = Math.max(streamUsage.inputTokens, u.inputTokens);
      streamUsage.outputTokens = Math.max(streamUsage.outputTokens, u.outputTokens);
    }
    // Headers already sent: meter best-effort, never fail the stream for it.
    // The new balance rides along as a final SSE event so the credit badge
    // updates without an extra round-trip.
    let streamBalance: number | null = null;
    try {
      streamBalance = await chargeForCall(req.user!.id, streamUsage, modelName, "ai generate stream");
    } catch (meterErr) {
      log.warn("Credit metering failed for generate stream:", meterErr);
    }
    if (streamBalance != null) {
      res.write(`data: ${JSON.stringify({ creditsBalance: streamBalance })}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error: any) {
    log.error("Gemini Streaming Error:", error);
    res.write(`data: ${JSON.stringify({ error: formatGeminiError(error) })}\n\n`);
    res.end();
  }
}));

// Multi-file project planning: one cheap call that returns a strict-JSON file
// manifest for the user's prompt. The client shows it for approval before any
// per-file generation runs, so the expensive loop never starts blind.
export const MAX_MANIFEST_FILES = 25;

router.post("/api/generate-manifest", requireAuth, requireCredits("manifest"), asyncRoute(async (req: AuthedRequest, res) => {
  const { prompt, maxFiles } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }
  const cap = Math.min(Math.max(parseInt(maxFiles, 10) || MAX_MANIFEST_FILES, 1), MAX_MANIFEST_FILES);

  const systemInstruction = `You are VibeCoder, an elite AI software architect. The user wants a multi-file React+TypeScript project. Your ONLY job is to plan the file structure — do NOT write any code.

Return STRICT JSON (no markdown fences, no prose, no commentary) with exactly this shape:
{"entry": "src/App.tsx", "files": [{"path": "src/components/Header.tsx", "purpose": "Top navigation bar with project switcher"}]}

Rules, all mandatory:
- "entry" must be exactly "src/App.tsx" and it must appear in "files".
- At most ${cap} files. Prefer fewer, well-factored files over many tiny ones.
- Every path is relative and under src/. No absolute paths, no ".." segments, no duplicates.
- React + TypeScript only. Components import each other with relative paths. No new npm dependencies.
- Every file must be independently meaningful — no junk-drawer utils files.
- "purpose" is one plain sentence per file describing its role.`;

  try {
    const { response: genResponse, modelName } = await generateWithFallback({
      contents: prompt,
      config: {
        systemInstruction,
        temperature: 0.3,
        responseMimeType: "application/json",
      },
    });

    const manifestBalance = await chargeForCall(req.user!.id, extractUsage(genResponse), modelName, "manifest planning");
    if (manifestBalance != null) res.set("X-Credits-Balance", String(manifestBalance));

    let manifest: any;
    try {
      const text = (genResponse.text || "").trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      manifest = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "The planner returned invalid JSON. Please try again." });
    }

    // The model produced this, not the user: malformed plans are 502s so the
    // client can retry, never silent acceptance of a broken manifest.
    if (!manifest || manifest.entry !== "src/App.tsx" || !Array.isArray(manifest.files) || manifest.files.length === 0) {
      return res.status(502).json({ error: "The planner returned an invalid manifest. Please try again." });
    }
    if (manifest.files.length > cap) {
      return res.status(502).json({ error: `The planner returned ${manifest.files.length} files (limit ${cap}). Please try again.` });
    }
    const seen = new Set<string>();
    const files: { path: string; purpose: string }[] = [];
    for (const f of manifest.files) {
      if (!f || typeof f.path !== "string" || typeof f.purpose !== "string") {
        return res.status(502).json({ error: "The planner returned a malformed file entry. Please try again." });
      }
      const clean = f.path.trim().replace(/^\/+/, "");
      if (!clean.startsWith("src/") || clean.includes("..") || seen.has(clean)) {
        return res.status(502).json({ error: `The planner returned an invalid path "${f.path}". Please try again.` });
      }
      seen.add(clean);
      files.push({ path: clean, purpose: f.purpose.trim().slice(0, 300) });
    }
    if (!seen.has("src/App.tsx")) {
      return res.status(502).json({ error: "The planner omitted the src/App.tsx entry point. Please try again." });
    }

    // Dependencies before dependents, entry last: when each file is generated,
    // every import target already exists in the workspace context.
    const entry = files.find((f) => f.path === "src/App.tsx")!;
    const rest = files.filter((f) => f.path !== "src/App.tsx");
    res.json({ entry: entry.path, files: [...rest, entry] });
  } catch (error: any) {
    log.error("Manifest Planning Error:", error);
    res.status(500).json({ error: formatGeminiError(error) });
  }
}));


export default router;
