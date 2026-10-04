// Whole-workspace project intelligence route.
import { Router } from "express";
import { asyncRoute } from "../async-route";
import fs from "fs";
import { formatGeminiError, generateWithFallback, extractUsage } from "../gemini";
import { getWorkspaceFiles, WorkspaceFile, uploadedDir as uploadedDirPath, resolveInsideDir } from "../workspace";
import { runPreFlightScan, formatFindingsForPrompt } from "../preflight-scan";
import {
  computeDeterministicAssessment,
  formatAssessmentForPrompt,
  fallbackReason,
  fallbackMissingReason,
  CATEGORY_KEYS,
} from "../deterministic-score";
import { log } from "../logger";
import { requireAuth, requireCredits, AuthedRequest } from "../middleware/requireAuth";
import { chargeForCall } from "../credits";

const router = Router();

// Bounds for client-supplied intelligence sources. The workspace ZIP path
// already has its own limits; these cover the virtual-file and selected-path
// variants so one request cannot blow up memory.
const MAX_INTEL_FILES = 200;
const MAX_INTEL_FILE_BYTES = 1024 * 1024;
const MAX_INTEL_TOTAL_BYTES = 5 * 1024 * 1024;


router.post("/api/project-intelligence", requireAuth, requireCredits("intelligence"), asyncRoute(async (req: AuthedRequest, res) => {
  try {
    let files: WorkspaceFile[] = [];
    const uploadedDir = uploadedDirPath(req.user!.id);

    // Source selection, in priority order. The client may name the exact
    // source it wants scored; the server never guesses.
    //
    // 1. codeFiles: raw code supplied by the client (e.g. the active editor
    //    code). Virtual files: the path is a display label only, the content
    //    never touches disk.
    const codeFiles = (req.body as any)?.codeFiles;
    if (Array.isArray(codeFiles) && codeFiles.length > 0) {
      if (codeFiles.length > MAX_INTEL_FILES) {
        return res.status(400).json({ error: `Too many files (limit ${MAX_INTEL_FILES}).` });
      }
      let totalChars = 0;
      for (const f of codeFiles) {
        if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
          return res.status(400).json({ error: "Each code file needs a string path and string content." });
        }
        if (f.content.length > MAX_INTEL_FILE_BYTES) {
          return res.status(400).json({ error: "One file exceeds the 1MB per-file limit." });
        }
        totalChars += f.content.length;
        if (totalChars > MAX_INTEL_TOTAL_BYTES) {
          return res.status(400).json({ error: "Files exceed the 5MB total limit." });
        }
        const label = f.path.trim().replace(/^\/+/, "").replace(/\.\./g, "").slice(0, 300) || "pasted-code.txt";
        files.push({ path: label, content: f.content, lineCount: f.content.split("\n").length });
      }
    } else if (Array.isArray((req.body as any)?.paths) && (req.body as any).paths.length > 0) {
      // 2. paths: selected files from the user's own uploaded workspace,
      //    resolved strictly inside their per-user directory.
      const paths = (req.body as any).paths;
      if (paths.length > MAX_INTEL_FILES) {
        return res.status(400).json({ error: `Too many files (limit ${MAX_INTEL_FILES}).` });
      }
      for (const p of paths) {
        if (typeof p !== "string" || p.length === 0) {
          return res.status(400).json({ error: "Invalid file path." });
        }
        const full = resolveInsideDir(uploadedDir, p);
        if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return res.status(400).json({ error: `Unknown workspace file: ${p.slice(0, 120)}` });
        }
        const content = fs.readFileSync(full, "utf8");
        if (content.length > MAX_INTEL_FILE_BYTES) {
          return res.status(400).json({ error: "One file exceeds the 1MB per-file limit." });
        }
        files.push({ path: p, content, lineCount: content.split("\n").length });
      }
    } else if (fs.existsSync(uploadedDir)) {
      // 3. The whole uploaded workspace.
      const scannedFiles = getWorkspaceFiles(uploadedDir, uploadedDir);
      if (scannedFiles.length > 0) {
        files = scannedFiles;
      }
    }

    // There is deliberately no fallback to the application's own directory.
    // An earlier version scanned process.cwd() with an exclusion list, which
    // silently graded GradeVibes' own source (test/, scripts/, ...) as the
    // user's project whenever no upload existed. No upload and no explicit
    // source means there is nothing of the user's to score.
    if (files.length === 0) {
      return res.status(200).json({
        notEnoughFiles: true,
        error: "Not enough files to run scan on your codebase. Upload a ZIP of your codebase, select a file, or generate code first!"
      });
    }

    const totalFiles = files.length;
    const totalLines = files.reduce((acc, f) => acc + f.lineCount, 0);

    // PreFlight deterministic pass over the whole workspace: line-anchored
    // security/quality findings the LLM report can cite as ground truth.
    const preflight = runPreFlightScan(files.map(f => ({ path: f.path, content: f.content })));

    // Build workspace context string for Gemini
    let workspaceContext = `You are evaluating a React/TypeScript project with ${totalFiles} file(s) totaling ${totalLines} line(s) of code.\n\n`;
    files.forEach(f => {
      workspaceContext += `--- FILE: ${f.path} (${f.lineCount} lines) ---\n`;
      // If code file is extremely large, send a subset, but most are small so send full content for extreme precision
      workspaceContext += f.content;
      workspaceContext += `\n---------------------------------------------\n\n`;
    });
    workspaceContext += `\n---\n${formatFindingsForPrompt(preflight)}\nWhen scoring the "security" category, weigh these deterministic findings; cite them by file and line in the reason instead of guessing.\n`;

    // Deterministic assessment: the 10 category scores, the missing-features
    // list, and the total are computed from scan evidence (pure functions —
    // identical input always yields identical numbers). The model explains
    // these facts; it does not invent or adjust them.
    const assessment = computeDeterministicAssessment(files, preflight);
    workspaceContext += `\n---\n${formatAssessmentForPrompt(assessment)}\n`;

    const INTEL_SYSTEM_PROMPT = `You are VibeCoder Project Intelligence Engine, an elite full-workspace software architect. 
Your task is to analyze the complete set of files in this project workspace, build a comprehensive file ledger, construct a complete application architecture map, and evaluate the overall codebase completeness score out of 100.

Since you are analyzing the entire project, you must look across ALL files to find implementations of features (e.g. database connections in server.ts or data directories, routing, utilities, frontend components in src/). Do not grade the app based on a single file.

Your response must be returned STRICTLY in this JSON format:
{
  "totalFiles": number,
  "totalLines": number,
  "overallSummary": string,
  "completenessScore": number,
  "categoryScores": {
    "serverStarts": { "score": number, "max": 10, "reason": string },
    "authentication": { "score": number, "max": 10, "reason": string },
    "databaseLayer": { "score": number, "max": 10, "reason": string },
    "errorHandling": { "score": number, "max": 10, "reason": string },
    "coreLogic": { "score": number, "max": 10, "reason": string },
    "backgroundAutomation": { "score": number, "max": 10, "reason": string },
    "externalIntegrations": { "score": number, "max": 10, "reason": string },
    "security": { "score": number, "max": 10, "reason": string },
    "performance": { "score": number, "max": 10, "reason": string },
    "documentationVerified": { "score": number, "max": 10, "reason": string }
  },
  "fileLedger": [
    {
      "filePath": string,
      "lineCount": number,
      "description": string,
      "contribution": string
    }
  ],
  "applicationMap": {
    "entrypoint": string,
    "components": [
      { "name": string, "filePath": string, "imports": [string] }
    ],
    "endpoints": [
      { "method": string, "path": string, "purpose": string }
    ]
  },
  "missingFeatures": [
    { "feature": string, "category": string, "reason": string }
  ]
}

CRITICAL RULES FOR PROJECT SCOPE ANALYSIS & INTENT DETECTION:
0. DETERMINISTIC GROUND TRUTH (OVERRIDES YOUR JUDGMENT ON NUMBERS):
   - The user message ends with a DETERMINISTIC GROUND TRUTH block listing the 10 category scores, the missing-features list, and the total completeness score, all computed from scan evidence. These are FINAL.
   - You MUST copy each category's score EXACTLY into categoryScores.<key>.score (max stays 10).
   - You MUST reproduce missingFeatures EXACTLY: same feature and category strings, same order. Do not add, remove, split, or reword entries.
   - completenessScore MUST equal the exact total shown (it is the precomputed sum).
   - Your judgment lives in the WORDS, not the numbers: write truthful, specific "reason" strings for every category and every missing feature, CITING the evidence anchors provided (file:line). Write overallSummary, fileLedger, and applicationMap from the code as usual.
   - Do not invent scores, do not invent missing features, do not hallucinate files. If the evidence says a capability is not in scope, say so in the reason — the score already reflects it.
0. DOMAIN INTENT & SCOPE DETECTION:
   - First, determine the application's intended domain and architectural scope by inspecting README.md, package.json description, component names, comments, and API endpoints.
   - STATELESS / PRIVACY-FIRST / STANDALONE UTILITIES: If the application is intentionally designed as a client-side utility, calculator, converter, generator, audio tool, or privacy-first app that requires no user accounts, database persistence, or payment processing, DO NOT PENALIZE the app for omitting them!
   - Award 10/10 for authentication, databaseLayer, and/or externalIntegrations if they are intentionally omitted by design, stating in the reason: "Not required for this stateless tool by intentional design scope."
   - ONLY penalize authentication, databaseLayer, or payments if there are "broken loops" or "dangling references" (e.g. code/UI references user logins, user profiles, paid credits, or Stripe payments, but the corresponding backend endpoints/webhooks are missing or broken).

1. OVERALL SUMMARY: Provide a highly polished summary in clear English describing what this accumulated set of files represents, its design philosophy, and what functions it enables.
2. FILE LEDGER: Every file in the project (excluding ignored ones) must have an entry detailing its business purpose ("description") and its exact value or contribution to the app's overall goals ("contribution").
3. APPLICATION MAP:
   - Identify the main entrypoint (e.g. index.html, src/main.tsx, or server.ts).
   - List each key frontend React component, its file path, and imports.
   - List each backend Express route, its HTTP method, its route path, and what business purpose it serves.
4. CATEGORY SCORE INTEGRITY (ACCURATE & DOMAIN-AWARE EVALUATION):
   Evaluate real, functional completeness relative to the app's intended scope, NOT arbitrary feature count:
   - serverStarts: Rate the backend Express server integration or frontend build/routing entrypoint. If the project is a Next.js app but is missing app/page.tsx, app/layout.tsx, or has no frontend "front door", rate this Category 2/10 or lower, explaining that a user hitting the URL will experience a 404.
   - authentication: Look across all files. If user sign-in or sessions are active, score highly. If the app needs logins but they are broken/stubbed, rate 0/10. Award 10/10 if authentication is irrelevant or intentionally omitted for this app's design scope.
   - databaseLayer: Look for DB storage setups. If DB files exist without active collections/tables, score low. If a DB is missing but needed for user state, score low. Award 10/10 if the app is a stateless/client-side tool by design.
   - errorHandling: Rate try/catch blocks and active error boundaries.
   - coreLogic: Rate the level of active, completed domain logic.
   - backgroundAutomation: Rate active cron/intervals/workers. Do NOT default to 10/10 if critical automation or webhooks (e.g. Stripe webhook handlers) are missing while payment helper files exist.
   - externalIntegrations: Rate active API integrations or award 10/10 if external services are not part of the design scope.
   - security: Score security practices (CORS, PORT bindings, no secrets committed, or privacy/data minimization practices).
   - performance: Rate code organization and build readiness.
   - documentationVerified: Rate TypeScript interfaces, comments, and file descriptions.

5. ACCURATE SCORING HARD-CAPS (MANDATORY):
   - CAP A (Missing Front Door / Routing): If the frontend is largely missing, lacks core page-level views/routes, or lacks main routing files (e.g., has isolated standalone components like ReferralStats or NegotiationReport but lacks app/page.tsx or app/layout.tsx to mount and route them), the total completenessScore MUST BE COERCED AND HARD-CAPPED AT A MAXIMUM OF 30/100. Lower category scores (like serverStarts and coreLogic) proportionally so that the sum of all 10 categories exactly equals this capped score.
   - CAP B (Incomplete API Infrastructure): If the ecosystem lists features like user logins, credit balances, purchases, and webhooks, but only has ONE single API endpoint actually implemented (e.g. /api/analyze), the total completenessScore MUST BE HARD-CAPPED AT A MAXIMUM OF 45/100.
   - CAP C (Broken Loop / Missing Webhooks): If helper utilities like Stripe clients are present but critical webhooks (like /api/stripe/webhook or similar) are missing, deduct at least 4 points from externalIntegrations and databaseLayer.
   
The total completenessScore must be exactly the sum of these 10 category scores. Keep the assessment professional, objective, realistic, and critical. A developer or stakeholder reading this report should find it 100% accurate regarding launch readiness. Do not invent or hallucinate files.`;

    const INTEL_SCHEMA = {
      type: "OBJECT",
      properties: {
        totalFiles: { type: "INTEGER" },
        totalLines: { type: "INTEGER" },
        overallSummary: { type: "STRING" },
        completenessScore: { type: "INTEGER" },
        categoryScores: {
          type: "OBJECT",
          properties: {
            serverStarts: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            },
            authentication: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            },
            databaseLayer: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            },
            errorHandling: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            },
            coreLogic: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            },
            backgroundAutomation: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            },
            externalIntegrations: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            },
            security: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            },
            performance: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            },
            documentationVerified: {
              type: "OBJECT",
              properties: { score: { type: "INTEGER" }, max: { type: "INTEGER" }, reason: { type: "STRING" } },
              required: ["score", "max", "reason"]
            }
          },
          required: [
            "serverStarts", "authentication", "databaseLayer", "errorHandling", "coreLogic",
            "backgroundAutomation", "externalIntegrations", "security", "performance", "documentationVerified"
          ]
        },
        fileLedger: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              filePath: { type: "STRING" },
              lineCount: { type: "INTEGER" },
              description: { type: "STRING" },
              contribution: { type: "STRING" }
            },
            required: ["filePath", "lineCount", "description", "contribution"]
          }
        },
        applicationMap: {
          type: "OBJECT",
          properties: {
            entrypoint: { type: "STRING" },
            components: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  filePath: { type: "STRING" },
                  imports: { type: "ARRAY", items: { type: "STRING" } }
                },
                required: ["name", "filePath", "imports"]
              }
            },
            endpoints: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  method: { type: "STRING" },
                  path: { type: "STRING" },
                  purpose: { type: "STRING" }
                },
                required: ["method", "path", "purpose"]
              }
            }
          },
          required: ["entrypoint", "components", "endpoints"]
        },
        missingFeatures: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              feature: { type: "STRING" },
              category: { type: "STRING" },
              reason: { type: "STRING" }
            },
            required: ["feature", "category", "reason"]
          }
        }
      },
      required: [
        "totalFiles", "totalLines", "overallSummary", "completenessScore",
        "categoryScores", "fileLedger", "applicationMap", "missingFeatures"
      ]
    };

    const { response: intelResponse, modelName } = await generateWithFallback({
      contents: workspaceContext,
      config: {
        systemInstruction: INTEL_SYSTEM_PROMPT,
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: INTEL_SCHEMA as any,
      },
    });
    const intelBalance = await chargeForCall(req.user!.id, extractUsage(intelResponse), modelName, "project intelligence");
    if (intelBalance != null) res.set("X-Credits-Balance", String(intelBalance));

    const responseText = intelResponse.text || "";
    let cleanText = responseText.trim();
    const startIdx = cleanText.indexOf("{");
    const endIdx = cleanText.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      cleanText = cleanText.substring(startIdx, endIdx + 1);
    }

    const parsedIntel = JSON.parse(cleanText);
    // Attach the deterministic report for the dedicated UI panel.
    parsedIntel.preflight = preflight;

    // Enforce determinism: the served report always carries the computed
    // scores and missing-feature list, even if the model drifted. The model's
    // reason strings are kept (that is its job now); numbers are facts.
    if (parsedIntel.categoryScores && typeof parsedIntel.categoryScores === "object") {
      for (const key of CATEGORY_KEYS) {
        const cat = parsedIntel.categoryScores[key] || {};
        parsedIntel.categoryScores[key] = {
          score: assessment.categories[key].score,
          max: 10,
          reason:
            typeof cat.reason === "string" && cat.reason.trim().length > 0
              ? cat.reason
              : fallbackReason(key, assessment),
        };
      }
    }
    parsedIntel.completenessScore = assessment.completenessScore;
    {
      const modelMissing = Array.isArray(parsedIntel.missingFeatures) ? parsedIntel.missingFeatures : [];
      const reasonByFeature = new Map<string, string>();
      for (const m of modelMissing) {
        if (m && typeof m.feature === "string" && typeof m.reason === "string" && m.reason.trim()) {
          if (!reasonByFeature.has(m.feature)) reasonByFeature.set(m.feature, m.reason);
        }
      }
      parsedIntel.missingFeatures = assessment.missingFeatures.map((f) => ({
        feature: f.feature,
        category: f.category,
        reason: reasonByFeature.get(f.feature) || fallbackMissingReason(f),
      }));
    }
    // Expose the deterministic assessment for debugging/transparency.
    parsedIntel.deterministicAssessment = {
      capsApplied: assessment.capsApplied,
      evidence: Object.fromEntries(
        CATEGORY_KEYS.map((k) => [k, assessment.categories[k].evidence])
      ),
    };
    res.json(parsedIntel);
  } catch (error: any) {
    log.error("Project Intelligence API Error:", error);
    res.status(500).json({ error: formatGeminiError(error) });
  }
}));



export default router;
