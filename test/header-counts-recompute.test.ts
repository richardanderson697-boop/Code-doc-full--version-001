// Header-counts recompute (spec §7, Option 1, APPROVED 2026-11-24):
// the panel's object (`intelResult.preflight`) is built in
// server/intelligence-scan.ts from the RAW preflight's counts plus the
// CALIBRATED findings, so the header ("1 critical") disagreed with the
// list (no critical). These tests assert on the object the panel renders
// — counts must be recomputed from the calibrated findings, never
// inherited from the raw scan.
//
// Fixture: a GET /api/admin/status handler returning only hardcoded
// values. The PreFlight auth probe fires "API Route Auth" CRITICAL
// ("GET /api/admin/status without auth check"), and the deterministic
// "Fabricated Status" finding for the same route demotes it to HIGH via
// calibrateNoAuthFindings — the exact 2026-11-09 shape (raw critical 1,
// calibrated critical 0).
import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../server/gemini", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/gemini")>();
  return {
    ...original,
    generateWithFallback: vi.fn(),
  };
});

import { generateWithFallback } from "../server/gemini";
import { runPreFlightScan } from "../server/preflight-scan";
import { computeDeterministicAssessment } from "../server/deterministic-score";
import { runIntelligenceScan } from "../server/intelligence-scan";
import authRouter from "../server/routes/auth";
import intelligenceRouter from "../server/routes/intelligence";
import { initStore } from "../server/store";

// The demotion corpus: sensitive route path (admin) so the auth probe
// fires per-route, plus an all-literal status response so the fabricated
// detector finds the same route.
const DEMOTION_CORPUS = [
  {
    path: "server/routes/status.js",
    content: `
const express = require('express');
const app = express();
app.get('/api/admin/status', (req, res) => {
  res.json({ status: 'Healthy', uptime: '99.9%' });
});
app.listen(3000);
`,
  },
];

// A corpus calibration never touches: hardcoded key + eval sink.
const UNTOUCHED_CORPUS = [
  {
    path: "server.js",
    content: `
import express from 'express';
const app = express();
const API_KEY = 'sk-live-FAKEKEYFORTESTS0123456789abcdef';
app.get('/run', (req, res) => {
  const cmd = req.query.cmd;
  eval(cmd);
  res.send('<h1>' + req.query.name + '</h1>');
});
app.listen(3000);
`,
  },
];

function toWorkspaceFiles(corpus: { path: string; content: string }[]) {
  return corpus.map((f) => ({
    path: f.path,
    content: f.content,
    lineCount: f.content.split("\n").length,
  }));
}

function recount(findings: { severity: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }
  return counts;
}

// The panel's header summary, verbatim logic from
// src/components/auditor/PreFlightFindingsPanel.tsx:28-30.
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;
function headerSummary(counts: Record<string, number>): string {
  return SEVERITY_ORDER.filter((sev) => counts[sev])
    .map((sev) => `${counts[sev]} ${sev}`)
    .join(" · ");
}

function cannedModelResponse() {
  return {
    response: {
      text: JSON.stringify({
        totalFiles: 1,
        totalLines: 10,
        overallSummary: "Test scan.",
        completenessScore: 50,
        categoryScores: {},
        fileLedger: [],
        applicationMap: {},
        missingFeatures: [],
      }),
    },
    modelName: "mock-test-model",
  };
}

describe("header counts are recomputed from the calibrated findings", () => {
  it("the demotion fixture really demotes: raw critical 1, calibrated high", () => {
    const files = toWorkspaceFiles(DEMOTION_CORPUS);
    const raw = runPreFlightScan(files.map((f) => ({ path: f.path, content: f.content })));
    const rawNoAuth = raw.findings.filter(
      (f) => f.probe === "API Route Auth" && f.title === "GET /api/admin/status without auth check"
    );
    expect(rawNoAuth.length).toBe(1);
    expect(rawNoAuth[0].severity).toBe("critical");
    expect(raw.counts.critical).toBe(1);

    const assessment = computeDeterministicAssessment(files, raw);
    const demoted = assessment.calibratedPreflightFindings.filter(
      (f) => f.probe === "API Route Auth" && f.title.startsWith("GET /api/admin/status without auth check")
    );
    expect(demoted.length).toBe(1);
    expect(demoted[0].severity).toBe("high");
    expect(demoted[0].title).toBe(
      "GET /api/admin/status without auth check — handler returns only hardcoded values"
    );
    // The deterministic "Fabricated Status" finding for the same route is
    // what drives the demotion — and it is not deleted by calibration.
    expect(
      assessment.deterministicFindings.some(
        (f) => f.probe === "Fabricated Status" && (f as any).route === "GET /api/admin/status"
      )
    ).toBe(true);
  });

  it("the panel object shows calibrated counts, not raw counts", async () => {
    vi.mocked(generateWithFallback).mockResolvedValueOnce(cannedModelResponse() as any);
    const files = toWorkspaceFiles(DEMOTION_CORPUS);
    const scan = await runIntelligenceScan(files, { userId: "header-test", fromWorkspace: false });
    const panel = scan.audit.preflight;
    expect(panel).toBeTruthy();
    // The 2026-11-09 shape, fixed: no critical in the header.
    expect(panel.counts.critical ?? 0).toBe(0);
    expect(headerSummary(panel.counts)).not.toContain("critical");
    // Header and list agree by construction: counts are the recount of
    // the calibrated findings the panel lists.
    expect(panel.counts).toEqual(recount(panel.findings));
    // Panel and assessment agree: the panel lists exactly the calibrated
    // findings, including the demoted high.
    const assessment = computeDeterministicAssessment(
      files,
      runPreFlightScan(files.map((f) => ({ path: f.path, content: f.content })))
    );
    expect(panel.findings).toEqual(assessment.calibratedPreflightFindings);
    expect(
      panel.findings.some(
        (f) =>
          f.probe === "API Route Auth" &&
          f.severity === "high" &&
          f.title === "GET /api/admin/status without auth check — handler returns only hardcoded values"
      )
    ).toBe(true);
  });

  it("regression: a corpus calibration never touches shows identical counts", async () => {
    vi.mocked(generateWithFallback).mockResolvedValueOnce(cannedModelResponse() as any);
    const files = toWorkspaceFiles(UNTOUCHED_CORPUS);
    const raw = runPreFlightScan(files.map((f) => ({ path: f.path, content: f.content })));
    const scan = await runIntelligenceScan(files, { userId: "header-test", fromWorkspace: false });
    expect(scan.audit.preflight.counts).toEqual(raw.counts);
    expect(scan.audit.preflight.counts).toEqual(recount(scan.audit.preflight.findings));
  });

  it("other consumers of the assessment are unaffected", async () => {
    vi.mocked(generateWithFallback).mockResolvedValueOnce(cannedModelResponse() as any);
    const files = toWorkspaceFiles(DEMOTION_CORPUS);
    const scan = await runIntelligenceScan(files, { userId: "header-test", fromWorkspace: false });
    // The deterministic assessment rides along untouched: same fabricated
    // finding, same scores, same scanner version.
    expect(
      scan.audit.deterministicAssessment.findings.some((f: any) => f.probe === "Fabricated Status")
    ).toBe(true);
    expect(typeof scan.audit.completenessScore).toBe("number");
    expect(scan.audit.deterministicAssessment.scannerVersion).toBeTruthy();
    expect(Object.keys(scan.audit.categoryScores).length).toBeGreaterThan(0);
  });

  it("the error path hands the caller the same calibrated counts", async () => {
    vi.mocked(generateWithFallback).mockRejectedValueOnce(new Error("429 RESOURCE_EXHAUSTED"));
    const files = toWorkspaceFiles(DEMOTION_CORPUS);
    let caught: any;
    try {
      await runIntelligenceScan(files, { userId: "header-test", fromWorkspace: false });
    } catch (err: any) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.preflight).toBeTruthy();
    expect(caught.preflight.counts.critical ?? 0).toBe(0);
    expect(caught.preflight.counts).toEqual(recount(caught.preflight.findings));
    expect(caught.calibratedPreflight.counts).toEqual(caught.preflight.counts);
  });
});

describe("header counts on the route response the panel consumes", () => {
  function buildApp() {
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use(authRouter);
    app.use(intelligenceRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err?.status || 500).json({ error: err?.message || "server error" });
    });
    return app;
  }

  beforeAll(async () => {
    await initStore();
  });

  let cookieCounter = 0;
  async function authedCookie(app: any): Promise<string> {
    cookieCounter += 1;
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: `header-counts-test-${cookieCounter}@x.io`, password: "supersecret1" });
    expect(res.status).toBe(201);
    const raw = res.headers["set-cookie"];
    const setCookie: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const session = setCookie.find((c) => c.startsWith("codedoc_session="));
    expect(session).toBeTruthy();
    return session!.split(";")[0];
  }

  it("POST /api/project-intelligence returns calibrated counts in res.body.preflight", async () => {
    vi.mocked(generateWithFallback).mockResolvedValueOnce(cannedModelResponse() as any);
    const app = buildApp();
    const res = await request(app)
      .post("/api/project-intelligence")
      .set("Cookie", await authedCookie(app))
      .send({
        codeFiles: DEMOTION_CORPUS.map((f) => ({ path: f.path, content: f.content })),
      });
    expect(res.status).toBe(200);
    expect(res.body.preflight).toBeTruthy();
    expect(res.body.preflight.counts.critical ?? 0).toBe(0);
    expect(headerSummary(res.body.preflight.counts)).not.toContain("critical");
    expect(res.body.preflight.counts).toEqual(recount(res.body.preflight.findings));
  });
});
