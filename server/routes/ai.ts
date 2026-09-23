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

const router = Router();

// 3.5. Heal truncated or interrupted code
router.post("/api/heal", requireAuth, requireCredits("heal"), asyncRoute(async (req: AuthedRequest, res) => {
  const { code, prompt } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Code content is required for healing" });
  }

  try {
    const systemInstruction = `You are VibeCoder Healing System, an expert React and TypeScript compilation specialist. 
Your sole task is to inspect a React component that was suddenly truncated or cut-off mid-stream during generation due to an API error, rate limit, or service timeout.
You will receive the partial/truncated code, and the original prompt describing the app.
You must:
1. Read the incomplete code carefully.
2. Analyze the unclosed curly braces, brackets, imports, or statements.
3. Complete and heal the code, ensuring all open structures are properly closed and any missing elements (like returning JSX elements or adding 'export default function App()') are appended correctly.
4. Keep all existing variables and logic intact. Do not rewrite from scratch unless it is completely corrupt.
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
    chargeForCall(req.user!.id, extractUsage(healedResponse), modelName, "ai heal");

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

    res.json({ healedCode: healedCode.trim() });
  } catch (error: any) {
    log.error("Healing API Error:", error);
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
    chargeForCall(req.user!.id, extractUsage(auditResponse), modelName, "ai audit pass 1");

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
        chargeForCall(req.user!.id, extractUsage(validationResponse), modelName, "ai audit validation pass");
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
    try {
      chargeForCall(req.user!.id, streamUsage, modelName, "ai generate stream");
    } catch (meterErr) {
      log.warn("Credit metering failed for generate stream:", meterErr);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error: any) {
    log.error("Gemini Streaming Error:", error);
    res.write(`data: ${JSON.stringify({ error: formatGeminiError(error) })}\n\n`);
    res.end();
  }
}));


export default router;
