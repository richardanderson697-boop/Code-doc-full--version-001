// Isolated "cold read" structured code auditor route.
import { Router } from "express";
import { asyncRoute } from "../async-route";
import { formatGeminiError, generateWithFallback, extractUsage } from "../gemini";
import { runDeterministicScan } from "../deterministic-scan";
import { runPreFlightScan, formatFindingsForPrompt } from "../preflight-scan";
import type { PreFlightReport } from "../../shared/preflight-types";
import { log } from "../logger";
import { requireAuth, requireCredits, AuthedRequest } from "../middleware/requireAuth";
import { chargeForCall } from "../credits";

const router = Router();


router.post("/api/cold-audit", requireAuth, requireCredits("coldAudit"), asyncRoute(async (req: AuthedRequest, res) => {
  const { code, fileName } = req.body;
  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "Code content is required for auditing" });
  }

  // Run the objective deterministic scan first to get fact-based clues
  const scan = runDeterministicScan(code);

  // PreFlight deterministic pass: pure-function probes over the submitted
  // file. Single-file scans skip project-level probes by nature; the path
  // fallback keeps the .tsx extension so the JS/React probes engage.
  //
  // runPreFlightScan never throws (it contains engine failures itself), but
  // this handler is async, so keep the call inside the try: an escaping
  // rejection here would be unhandled and take the process down rather than
  // returning a 500.
  let preflight: PreFlightReport;
  try {
    preflight = runPreFlightScan([
      { path: typeof fileName === "string" && fileName.trim() ? fileName : "workspace/App.tsx", content: code },
    ]);
  } catch (scanErr: any) {
    log.error("PreFlight scan escaped its own guard:", scanErr);
    return res.status(500).json({ error: "Deterministic scan failed unexpectedly." });
  }

  const AUDIT_SYSTEM_PROMPT = `You are VibeCoder File Evidence Extractor, an elite, completely objective React/TypeScript software inspector.
Your sole task is to analyze the provided source code with ABSOLUTELY NO memory, bias, or assumptions.
You did NOT write this code and have absolutely NO knowledge of any user intent, user prompt, requested specification, or conversation that produced this code.
You must perform a 100% "cold read" and extract ONLY immutable facts and features that are actually written in this specific file.

CRITICAL PRINCIPLES:
1. NO SCORING OR EVALUATION: You are strictly FORBIDDEN from calculating or returning any score, grading, rating, or evaluation. Do not judge or evaluate completeness.
2. NO APPLICATION-LEVEL JUDGMENT: Do not make assertions about what is "missing", "incomplete", "not required" or what the app "is designed as".
   - If there is no authentication code in this file, write "No authentication-related code detected in this file" as the conclusion. Do NOT write "Authentication is missing from the application" or "Authentication is not required for this design scope."
   - Do NOT assume the app is designed as a single-user tool, or comment on any security or completeness levels.
3. DESCRIBE WHAT IS PRESENT: Describe functions, states, hooks, imports, and interactions in plain English business terms.
   - For each function, state, hook, import, or key logic chunk in the file, describe what business or technical function it serves.
4. EVERY FINDING MUST BE A FACTUAL EVIDENCE ITEM:
   For every single item you report, extract the line numbers, the exact character-for-character code snippet, a pure English business conclusion, and your confidence level.

ALLOWED FINDINGS EXAMPLES (in the conclusion field):
- "Function handleSave sends POST request to /api/projects."
- "Component imports HistorySidebar."
- "State variable currentProject exists."
- "No authentication-related code detected in this file."

NOT ALLOWED FINDINGS EXAMPLES (DO NOT WRITE THESE):
- "Authentication is missing from the application."
- "Authentication is not required."
- "The app is designed as a single-user tool."
- "The security score is 10/10."

Keep the assessment highly detailed, precise, professional, and strictly factual. Ensure the lines map accurately.`;

  // Pre-process code by numbering lines
  const numberedCode = code.split("\n").map((line: string, i: number) => `${i + 1}\t${line}`).join("\n");

  const AUDIT_SCHEMA = {
    type: "OBJECT",
    properties: {
      truncated: { type: "BOOLEAN" },
      fileName: { type: "STRING" },
      evidence: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            lines: { type: "STRING" },
            codeSnippet: { type: "STRING" },
            conclusion: { type: "STRING" },
            confidence: { type: "STRING", enum: ["High", "Medium", "Low"] }
          },
          required: ["lines", "codeSnippet", "conclusion", "confidence"]
        }
      }
    },
    required: ["truncated", "fileName", "evidence"]
  };

  try {
    // Inside the try: if both Gemini models fail, the catch below still
    // returns the deterministic PreFlight report instead of hanging the
    // request on an unhandled async throw.
    const { response: auditResponse, modelName } = await generateWithFallback({
      contents: `${numberedCode}\n\n---\n${formatFindingsForPrompt(preflight)}`,
      config: {
        systemInstruction: AUDIT_SYSTEM_PROMPT,
        temperature: 0.1, // extremely low temperature for pure objective analysis
        responseMimeType: "application/json",
        responseSchema: AUDIT_SCHEMA as any,
      },
    });
    const coldAuditBalance = chargeForCall(req.user!.id, extractUsage(auditResponse), modelName, "cold audit");
    if (coldAuditBalance != null) res.set("X-Credits-Balance", String(coldAuditBalance));

    const responseText = auditResponse.text || "";
    let cleanText = responseText.trim();
    
    const startIdx = cleanText.indexOf("{");
    const endIdx = cleanText.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      cleanText = cleanText.substring(startIdx, endIdx + 1);
    } else {
      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.substring(7);
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.substring(3);
      }
      if (cleanText.endsWith("```")) {
        cleanText = cleanText.substring(0, cleanText.length - 3);
      }
      cleanText = cleanText.trim();
    }

    const parsedData = JSON.parse(cleanText);

    // Merge in deterministic findings to guarantee completeness of evidence!
    parsedData.evidence = parsedData.evidence || [];

    // Check if the file actually has any auth keywords, if not, explicitly add the fact to reassure the user
    const hasAuthKeywords = /\b(login|signup|signin|signout|auth|register|jwt|bcrypt|session|cookie|token)\b/i.test(code);
    if (!hasAuthKeywords && !parsedData.evidence.some((e: any) => e.conclusion.toLowerCase().includes("authentication"))) {
      parsedData.evidence.push({
        lines: "1-" + code.split("\n").length,
        codeSnippet: "// Full file scan",
        conclusion: "No authentication-related code detected in this file.",
        confidence: "High"
      });
    }

    // Add Todo Evidence
    scan.todos.forEach(item => {
      if (!parsedData.evidence.some((e: any) => e.lines === item.lines || e.codeSnippet === item.code)) {
        parsedData.evidence.push({
          lines: item.lines,
          codeSnippet: item.code,
          conclusion: "Developer TODO comment found requiring active implementation.",
          confidence: "High"
        });
      }
    });

    // Add Stub Evidence
    scan.stubs.forEach(item => {
      if (!parsedData.evidence.some((e: any) => e.lines === item.lines || e.codeSnippet === item.code)) {
        parsedData.evidence.push({
          lines: item.lines,
          codeSnippet: item.code,
          conclusion: "Stub/mock placeholder logic detected that lacks a production-ready implementation.",
          confidence: "High"
        });
      }
    });

    // Add Hardcoded Ports Evidence
    scan.hardcodedPorts.forEach(item => {
      if (!parsedData.evidence.some((e: any) => e.lines === item.lines || e.codeSnippet === item.code)) {
        parsedData.evidence.push({
          lines: item.lines,
          codeSnippet: item.code,
          conclusion: "Production Risk: Hardcoded port referenced directly instead of dynamically binding to process.env.PORT.",
          confidence: "High"
        });
      }
    });

    // Add TS Type Bypasses Evidence
    scan.anyUsages.slice(0, 5).forEach(item => {
      if (!parsedData.evidence.some((e: any) => e.lines === item.lines || e.codeSnippet === item.code)) {
        parsedData.evidence.push({
          lines: item.lines,
          codeSnippet: item.code,
          conclusion: "Type bypass (: any) used, bypassing compiler type checks and reducing TypeScript safety guarantees.",
          confidence: "High"
        });
      }
    });

    // Add Fetch/Axios calls Evidence
    scan.fetchCalls.forEach(item => {
      if (!parsedData.evidence.some((e: any) => e.lines === item.lines || e.codeSnippet === item.code)) {
        parsedData.evidence.push({
          lines: item.lines,
          codeSnippet: item.code,
          conclusion: "Function/line performs an external API request via fetch or axios.",
          confidence: "High"
        });
      }
    });

    // Add PreFlight deterministic findings as evidence items (line-anchored,
    // already verified — no LLM judgment involved).
    preflight.findings.forEach(f => {
      const lines = f.line ? String(f.line) : "1";
      if (!parsedData.evidence.some((e: any) => e.conclusion === f.title && e.lines === lines)) {
        parsedData.evidence.push({
          lines,
          codeSnippet: f.evidence || "// See PreFlight finding details",
          conclusion: `PreFlight ${f.probe} (${f.severity}): ${f.title}`,
          confidence: "High"
        });
      }
    });

    // Attach the full deterministic report for the dedicated UI panel.
    parsedData.preflight = preflight;

    // Return the clean, score-free evidence sheet!
    res.json(parsedData);
  } catch (error: any) {
    log.error("Cold Audit API Error:", error);
    // The deterministic scan already ran; return it so the client can still
    // render ground-truth findings when the LLM layer is unavailable.
    res.status(500).json({ error: formatGeminiError(error), preflight });
  }
}));

export default router;
