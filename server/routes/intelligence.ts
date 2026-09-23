// Whole-workspace project intelligence route.
import { Router } from "express";
import { asyncRoute } from "../async-route";
import path from "path";
import fs from "fs";
import { formatGeminiError, generateWithFallback, extractUsage } from "../gemini";
import { getWorkspaceFiles, WorkspaceFile, uploadedDir as uploadedDirPath } from "../workspace";
import { runPreFlightScan, formatFindingsForPrompt } from "../preflight-scan";
import { log } from "../logger";
import { requireAuth, requireCredits, AuthedRequest } from "../middleware/requireAuth";
import { chargeForCall } from "../credits";

const router = Router();


router.post("/api/project-intelligence", requireAuth, requireCredits("intelligence"), asyncRoute(async (req: AuthedRequest, res) => {
  try {
    let files: WorkspaceFile[] = [];
    const uploadedDir = uploadedDirPath();
    let isUploadedProject = false;

    if (fs.existsSync(uploadedDir)) {
      const scannedFiles = getWorkspaceFiles(uploadedDir, uploadedDir);
      if (scannedFiles.length > 0) {
        files = scannedFiles;
        isUploadedProject = true;
      }
    }

    if (!isUploadedProject) {
      const workspaceFiles = getWorkspaceFiles(process.cwd());

      // Files that make up the Code Doc application itself. If only these
      // exist, the user has not uploaded or created their own codebase.
      // Directory prefixes cover the app's own source trees so refactors
      // don't silently reclassify app code as a user project.
      const DEFAULT_FILES = new Set([
        "server.ts",
        "package.json",
        "tsconfig.json",
        "vite.config.ts",
        "index.html",
        "metadata.json",
        "bun.lock",
        "package-lock.json",
        "yarn.lock",
        ".env.example",
        ".npmrc",
        "README.md"
      ]);
      const DEFAULT_PREFIXES = ["src/", "server/", "shared/", "assets/", "docs/"];

      const customFiles = workspaceFiles.filter(
        f => !DEFAULT_FILES.has(f.path) && !DEFAULT_PREFIXES.some(p => f.path.startsWith(p))
      );

      if (customFiles.length === 0) {
        return res.status(200).json({
          notEnoughFiles: true,
          error: "Not enough files to run scan on your codebase. Or upload a ZIP of your codebase to get a total scoring analysis!"
        });
      }
      files = customFiles;
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
    chargeForCall(req.user!.id, extractUsage(intelResponse), modelName, "project intelligence");

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
    res.json(parsedIntel);
  } catch (error: any) {
    log.error("Project Intelligence API Error:", error);
    res.status(500).json({ error: formatGeminiError(error) });
  }
}));



export default router;
