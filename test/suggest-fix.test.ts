// Tests for POST /api/suggest-fix (review-only per-finding suggested fix)
// and for the shared dev-handoff packet renderer.
//
// Route contract, mirroring /api/heal:
// - success returns a structured suggestion and charges credits;
// - an empty model response is a 500 with a clear message and NO charge;
// - a SAFETY block gets its own message and NO charge.
// Packet contract: the exported Markdown contains every schema section from
// docs/dev-handoff-packet-schema.md.
import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";

// formatGeminiError short-circuits to "key not set" when there is no real key;
// a dummy keeps the route's own error messages intact for assertions.
process.env.GEMINI_API_KEY = "test-key";

// Controllable mock so each test decides what the model returns.
let nextText = "";
let nextFinishReason: string | undefined = undefined;
vi.mock("../server/gemini", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/gemini")>();
  return {
    ...original,
    generateWithFallback: vi.fn(async () => ({
      response: {
        text: nextText,
        candidates: nextFinishReason ? [{ finishReason: nextFinishReason }] : [],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
      },
      modelName: "test-model",
    })),
  };
});

import authRouter from "../server/routes/auth";
import aiRouter from "../server/routes/ai";
import { initStore } from "../server/store";
import { renderDevHandoffPacket } from "../shared/dev-handoff-packet";

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authRouter);
  app.use(aiRouter);
  return app;
}

beforeAll(async () => {
  await initStore();
});

async function authedCookie(app: any, tag: string): Promise<{ cookie: string; startBalance: number }> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: `${tag}@x.io`, password: "supersecret1" });
  expect(signup.status).toBe(201);
  const raw = signup.headers["set-cookie"] as unknown as string[];
  const cookie = (Array.isArray(raw) ? raw : [raw])[0].split(";")[0];
  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
  return { cookie, startBalance: me.body.user.credits };
}

async function balanceOf(app: any, cookie: string): Promise<number> {
  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
  return me.body.user.credits;
}

const FINDING = {
  file: "server/index.ts",
  line: 12,
  message: "CORS policy configured to wildcard origin (*)",
  severity: "medium",
  type: "cors-wildcard",
  suggestion: "Restrict CORS allowed origins to specific domain environment variables.",
  codeContext: "app.use(cors({ origin: '*' })); // CORS Security Risk",
};

const MODEL_FIX = {
  plainEnglishIssue:
    "Any website can make requests to this API in a visitor's browser, so a malicious page could act on their behalf.",
  evidence: "server/index.ts:12\napp.use(cors({ origin: '*' })); // CORS Security Risk",
  remediationDiff:
    "--- a/server/index.ts\n+++ b/server/index.ts\n- app.use(cors({ origin: '*' }));\n+ app.use(cors({ origin: process.env.FRONTEND_URL }));",
  verificationSteps: [
    "Set FRONTEND_URL to the app's domain and restart the server.",
    "Confirm requests from other origins are rejected by the browser.",
  ],
};

describe("POST /api/suggest-fix", () => {
  it("returns a structured suggestion and charges credits", async () => {
    const app = buildApp();
    const { cookie, startBalance } = await authedCookie(app, "suggest-fix-ok");
    // Fenced on purpose: the route must strip fences and still parse.
    nextText = "```json\n" + JSON.stringify(MODEL_FIX) + "\n```";
    nextFinishReason = undefined;

    const res = await request(app).post("/api/suggest-fix").set("Cookie", cookie).send(FINDING);

    expect(res.status).toBe(200);
    expect(res.body.suggestion.plainEnglishIssue).toContain("Any website");
    expect(res.body.suggestion.evidence).toContain("server/index.ts:12");
    expect(res.body.suggestion.remediationDiff).toContain("FRONTEND_URL");
    expect(res.body.suggestion.remediationDiff).not.toContain("```");
    expect(res.body.suggestion.verificationSteps).toHaveLength(2);
    expect(await balanceOf(app, cookie)).toBeLessThan(startBalance);
  });

  it("rejects a missing finding message or file with 400 (no model call)", async () => {
    const app = buildApp();
    const { cookie } = await authedCookie(app, "suggest-fix-bad-input");
    nextText = JSON.stringify(MODEL_FIX);

    const res = await request(app).post("/api/suggest-fix").set("Cookie", cookie).send({ file: "a.ts" });
    expect(res.status).toBe(400);
  });

  it("returns an error (not 200) and charges nothing on an empty model response", async () => {
    const app = buildApp();
    const { cookie, startBalance } = await authedCookie(app, "suggest-fix-empty");
    nextText = "";
    nextFinishReason = undefined;

    const res = await request(app).post("/api/suggest-fix").set("Cookie", cookie).send(FINDING);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/empty response/i);
    expect(res.body.error).toMatch(/no credits were charged/i);
    expect(await balanceOf(app, cookie)).toBe(startBalance);
  });

  it("explains a SAFETY block and charges nothing", async () => {
    const app = buildApp();
    const { cookie, startBalance } = await authedCookie(app, "suggest-fix-safety");
    nextText = "";
    nextFinishReason = "SAFETY";

    const res = await request(app).post("/api/suggest-fix").set("Cookie", cookie).send(FINDING);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/safety filters/i);
    expect(await balanceOf(app, cookie)).toBe(startBalance);
  });

  it("rejects unparseable model output and charges nothing", async () => {
    const app = buildApp();
    const { cookie, startBalance } = await authedCookie(app, "suggest-fix-garbage");
    nextText = "here is some prose, not JSON at all {{{";
    nextFinishReason = undefined;

    const res = await request(app).post("/api/suggest-fix").set("Cookie", cookie).send(FINDING);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/could not be read/i);
    expect(await balanceOf(app, cookie)).toBe(startBalance);
  });
});

describe("dev handoff packet renderer", () => {
  const markdown = renderDevHandoffPacket({
    product: "GradeVibes",
    finding: {
      title: FINDING.message,
      message: FINDING.message,
      severity: FINDING.severity,
      type: FINDING.type,
      file: FINDING.file,
      line: FINDING.line,
      suggestion: FINDING.suggestion,
    },
    fix: MODEL_FIX,
    generatedAt: "2026-10-05T12:00:00.000Z",
  });

  it("contains every schema section", () => {
    // Header: product, timestamp, review-only status.
    expect(markdown).toContain("GradeVibes");
    expect(markdown).toContain("2026-10-05T12:00:00.000Z");
    expect(markdown).toMatch(/NOT applied|REVIEW ONLY/i);
    // Finding title.
    expect(markdown).toContain("## Finding");
    expect(markdown).toContain(FINDING.message);
    // Source finding: message, severity, type, scanner recommendation.
    expect(markdown).toContain("## Source finding");
    expect(markdown).toContain("medium");
    expect(markdown).toContain("cors-wildcard");
    expect(markdown).toContain("Restrict CORS allowed origins");
    // Plain-English issue.
    expect(markdown).toContain("## Plain-English issue");
    expect(markdown).toContain("Any website can make requests");
    // Evidence with file:line anchor.
    expect(markdown).toContain("## Evidence");
    expect(markdown).toContain("server/index.ts:12");
    // Suggested remediation (diff preserved, not double-fenced).
    expect(markdown).toContain("## Suggested remediation");
    expect(markdown).toContain("FRONTEND_URL");
    expect(markdown).not.toMatch(/```diff\n```/);
    // Verification steps.
    expect(markdown).toContain("## How to verify the fix");
    expect(markdown).toContain("restart the server");
    // Runtime disclaimer.
    expect(markdown).toContain("## Runtime disclaimer");
    expect(markdown).toMatch(/not executed/i);
    // Not-exhaustive / human-review notice + v1 no-estimates line.
    expect(markdown).toContain("## Scope notice");
    expect(markdown).toMatch(/not exhaustive/i);
    expect(markdown).toMatch(/human.*review/i);
    expect(markdown).toMatch(/No effort estimates are included in v1/);
  });
});

describe("dev handoff packet fence safety", () => {
  it("keeps model-emitted fences inside evidence from breaking the packet", () => {
    // Real-world case: the model returned the evidence already wrapped in its
    // own fenced block. The packet must lengthen its outer fence instead of
    // nesting triple fences (which rendered as a garbled block).
    const packet = renderDevHandoffPacket({
      product: "GradeVibes",
      finding: {
        title: FINDING.message,
        message: FINDING.message,
        severity: FINDING.severity,
        type: FINDING.type,
        file: "server.ts",
        line: 1,
        suggestion: FINDING.suggestion,
      },
      fix: {
        ...MODEL_FIX,
        evidence:
          "File: server.ts:1\n```typescript\napp.use('/api/sensitive-data', sensitiveDataRouter);\n```",
      },
      generatedAt: "2026-10-05T12:00:00.000Z",
    });
    // Outer fence is lengthened past the embedded triple fences...
    expect(packet).toContain("````");
    // ...and the snippet survives intact, fences included.
    expect(packet).toContain("```typescript");
    expect(packet).toContain("app.use('/api/sensitive-data', sensitiveDataRouter);");
    // Fences stay balanced: every opened block is closed.
    const fenceLines = packet.split("\n").filter((l) => /^`{3,}/.test(l.trim()));
    expect(fenceLines.length % 2).toBe(0);
  });
});
