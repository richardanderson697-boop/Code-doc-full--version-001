// README-truth + fabricated-status detector tests.
// Spec: finalread-readme-truth-and-fabricated-status-spec.md §7.
// Two detectors, one calibration:
//   1-3  README vs repo (Documentation cap at 4/10)
//   4-7  fabricated status responses (needs-verification finding)
//   8-9  calibration: a no-auth finding on a fabricated route is
//        reframed critical -> high, so the Security cap moves 4 -> 6.
import { describe, it, expect } from "vitest";
import { computeDeterministicAssessment } from "../server/deterministic-score";
import type { PreFlightReport } from "../shared/preflight-types";
import type { WorkspaceFile } from "../server/workspace";
import { buildFinalReadReport } from "../shared/finalread-report";
import { intelResultToFinalReadInput } from "../src/components/auditor/FinalReadOverlay";

function wf(path: string, content: string): WorkspaceFile {
  return { path, content, lineCount: content.split("\n").length } as WorkspaceFile;
}

function emptyPreflight(score = 100): PreFlightReport {
  return {
    engine: "PreFlight",
    probeCount: 113,
    filesScanned: 1,
    filesSkipped: [],
    score,
    counts: {},
    findings: [],
    probeFailures: [],
    failed: null,
  };
}

function preflightWith(findings: unknown[]): PreFlightReport {
  return { ...emptyPreflight(100), findings: findings as PreFlightReport["findings"] };
}

// Five small files with TypeScript interfaces — the +3 type points, so the
// Documentation base is 7 (README +4, comments +0, types +3) and only a
// cap can move it.
const TYPE_FILES = [1, 2, 3, 4, 5].map((n) =>
  wf(`src/types${n}.ts`, `export interface Type${n} {\n  id: string;\n  name: string;\n}\n`)
);
const PKG = wf(
  "package.json",
  // Express only, deliberately no react: a react dep with no
  // index.html / src/main.tsx / src/App.tsx would trip CAP A (missing
  // front door) and scale every category down, hiding the cap under test.
  JSON.stringify({ name: "rentstream", dependencies: { express: "^4.0.0" } })
);

function readmeWith(claims: string[]): string {
  const lines = ["# RentStream", "", "A property management platform.", "", ...claims];
  // Pad past 50 lines so the README length points (+4) count — the cap,
  // not the length, is what these tests prove.
  while (lines.length < 55) lines.push("Additional documentation line.");
  return lines.join("\n");
}

// The RentStream shape (spec §2): five named paths that do not exist and
// eleven named stack technologies the code never uses.
const RENTSTREAM_CLAIMS = [
  "## Architecture",
  "",
  "- `apps/api` — NestJS backend API",
  "- `apps/mobile` — React Native mobile app",
  "- `apps/web` — React web dashboard",
  "- `packages/database` — Prisma schema and migrations",
  "- `docs/architecture` — architecture decision records",
  "",
  "## Tech Stack",
  "",
  "- NestJS with TypeORM and Prisma",
  "- PostgreSQL with Redis caching",
  "- React Native mobile app",
  "- OpenAI and Anthropic for AI features",
  "- Stripe for payments",
  "- Docker and AWS for deployment",
];

// Two endpoints, so the fixture does not trip CAP B (single-endpoint API
// surface), which would scale every category down and hide the cap under
// test. The responses are not object literals with a status word, so no
// fabricated-status finding fires here.
const DOCS_SERVER = `import express from "express";
const app = express();
app.get("/api/items", (req, res) => { res.json([]); });
app.get("/api/items/:id", (req, res) => { res.json({}); });
app.listen(3000);
`;

describe("README vs repo (Documentation cap)", () => {
  it("1. caps Documentation at 4 when the README names missing paths and an absent stack", () => {
    const a = computeDeterministicAssessment(
      [wf("README.md", readmeWith(RENTSTREAM_CLAIMS)), PKG, ...TYPE_FILES, wf("server.ts", DOCS_SERVER)],
      emptyPreflight()
    );
    expect(a.categories.documentationVerified.score).toBe(4);
    expect(a.categories.documentationVerified.note).toBe("readme-mismatch");
    const evidence = a.categories.documentationVerified.evidence.join(" ");
    expect(evidence).toMatch(/apps\/api/);
    expect(evidence).toMatch(/nestjs/);
    expect(a.capsApplied.join(" ")).toMatch(/README describes paths\/technologies not in the repo: Documentation capped at 4\/10/);
  });

  it("2. does not fire below the threshold (1 missing path, 1 absent tech)", () => {
    const a = computeDeterministicAssessment(
      [
        wf("README.md", readmeWith(["- `apps/api` — NestJS backend API", "- Built with NestJS."])),
        PKG,
        ...TYPE_FILES,
        wf("server.ts", DOCS_SERVER),
      ],
      emptyPreflight()
    );
    // Base 7 (README +4, types +3): unchanged, because nothing capped it.
    expect(a.categories.documentationVerified.score).toBe(7);
    expect(a.categories.documentationVerified.note).not.toBe("readme-mismatch");
    expect(a.capsApplied.join(" ")).not.toMatch(/README describes/);
  });

  it("3. leaves an accurate README alone", () => {
    const a = computeDeterministicAssessment(
      [
        wf(
          "README.md",
          readmeWith(["- `apps/web` — React web dashboard", "- `packages/database` — schema", "- Deployed with Docker."])
        ),
        PKG,
        ...TYPE_FILES,
        wf("server.ts", DOCS_SERVER),
        wf("apps/web/index.ts", "export const app = 1;\n"),
        wf("packages/database/schema.prisma", "model User {\n  id String @id\n}\n"),
        wf("Dockerfile", "FROM node:20\n"),
      ],
      emptyPreflight()
    );
    expect(a.categories.documentationVerified.score).toBe(7);
    expect(a.categories.documentationVerified.note).not.toBe("readme-mismatch");
    expect(a.capsApplied.join(" ")).not.toMatch(/README describes/);
  });
});

// The RentStream metrics route (spec §4), verbatim shape: an all-literal
// object with a status word, no query or check behind it.
const METRICS_SERVER = `import express from "express";
const app = express();
app.get("/api/admin/metrics", (req, res) => {
  res.json({
    activeUsers: 1452,
    bookingsToday: 89,
    systemHealth: "Healthy",
    databaseStatus: "Connected",
  });
});
app.listen(3000);
`;

// The same route, but the values are computed — a real handler.
const REAL_SERVER = `import express from "express";
const app = express();
app.get("/api/admin/metrics", async (req, res) => {
  const rows = await db.query("SELECT count(*) FROM users");
  res.json({ activeUsers: rows.length, databaseStatus: "Healthy" });
});
app.post("/api/chat", async (req, res) => {
  const replyText = await generateReply(req.body.message);
  res.json({ reply: replyText, tokensUsed: 42 });
});
app.listen(3000);
`;

function fabricatedFindings(a: ReturnType<typeof computeDeterministicAssessment>) {
  return a.deterministicFindings.filter((f) => f.probe === "Fabricated Status");
}

describe("fabricated status responses", () => {
  it("4. fires on the RentStream metrics route, needs-verification, route recorded", () => {
    const a = computeDeterministicAssessment([wf("server.ts", METRICS_SERVER)], emptyPreflight());
    const found = fabricatedFindings(a);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe("Endpoint returns hardcoded values presented as live metrics");
    expect(found[0].severity).toBe("medium");
    expect(found[0].unverified).toBe(true);
    expect(found[0].route).toBe("GET /api/admin/metrics");
    expect(found[0].file).toBe("server.ts");
    expect(found[0].line).toBe(4);
    expect(found[0].evidence).toMatch(/systemHealth: "Healthy"/);
  });

  it("4b. routes to needsVerification in the report, never a liability", () => {
    const a = computeDeterministicAssessment([wf("server.ts", METRICS_SERVER)], emptyPreflight());
    const input = intelResultToFinalReadInput({
      completenessScore: 45,
      deterministicAssessment: { findings: a.deterministicFindings },
    });
    const report = buildFinalReadReport(input);
    expect(report.needsVerification.map((i) => i.title)).toEqual([
      "Endpoint returns hardcoded values presented as live metrics",
    ]);
    expect(report.liabilities).toEqual([]);
  });

  it("4c. does not fire on a commented-out res.json example", () => {
    // A doc example or a disabled handler is not a live endpoint. This
    // is the shape of the header comment in deterministic-scan.ts itself,
    // which the finder used to flag on the GradeVibes self-scan.
    const commented = `// The RentStream pattern:
//   res.json({ activeUsers: 1452, bookingsToday: 89,
//              systemHealth: 'Healthy', databaseStatus: 'Connected' });
/*
app.get("/api/admin/metrics", (req, res) => {
  res.json({ activeUsers: 1, systemHealth: "Healthy" });
});
*/
export const x = 1;
`;
    const a = computeDeterministicAssessment([wf("server.ts", commented)], emptyPreflight());
    expect(fabricatedFindings(a)).toHaveLength(0);
  });

  it("4d. still fires when a quote-bearing regex precedes the endpoint", () => {
    // The comment stripper must skip regex literals whole: a quote
    // inside /['"]/ would otherwise toggle its string states and hide
    // the endpoint below (and the division must not read as a regex).
    const withRegex = `const KEY_STRIP = /^['"\`]|['"\`]$/g;
const DIV = 10 / 2;
import express from "express";
const app = express();
app.get("/api/admin/metrics", (req, res) => {
  res.json({ activeUsers: 1452, systemHealth: "Healthy" });
});
app.listen(3000);
`;
    const a = computeDeterministicAssessment([wf("server.ts", withRegex)], emptyPreflight());
    const found = fabricatedFindings(a);
    expect(found).toHaveLength(1);
    expect(found[0].route).toBe("GET /api/admin/metrics");
  });

  it("5. does not fire on a bare single-field liveness response", () => {
    const health = `import express from "express";
const app = express();
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
app.listen(3000);
`;
    const a = computeDeterministicAssessment([wf("server.ts", health)], emptyPreflight());
    expect(fabricatedFindings(a)).toHaveLength(0);
  });

  it("6. does not fire on a multi-field liveness route (/health)", () => {
    const health = `import express from "express";
const app = express();
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: 12345 });
});
app.listen(3000);
`;
    const a = computeDeterministicAssessment([wf("server.ts", health)], emptyPreflight());
    expect(fabricatedFindings(a)).toHaveLength(0);
  });

  it("7. does not fire when the values are computed (await / identifier)", () => {
    const a = computeDeterministicAssessment([wf("server.ts", REAL_SERVER)], emptyPreflight());
    expect(fabricatedFindings(a)).toHaveLength(0);
  });
});

function noAuthFinding() {
  return {
    severity: "critical",
    probe: "API Route Auth",
    title: "GET /api/admin/metrics without auth check",
    file: "server.ts",
    line: 3,
    evidence: "app.get('/api/admin/metrics', handler)",
    remediation: "Add auth middleware",
  };
}

describe("fabricated-status calibration (§5)", () => {
  it("8. reframes the no-auth finding and moves the Security cap 4 -> 6 on a fabricated route", () => {
    const pf = preflightWith([noAuthFinding()]);
    const a = computeDeterministicAssessment([wf("server.ts", METRICS_SERVER)], pf);
    expect(fabricatedFindings(a)).toHaveLength(1);
    expect(a.calibratedPreflightFindings).toHaveLength(1);
    expect(a.calibratedPreflightFindings[0].severity).toBe("high");
    expect(a.calibratedPreflightFindings[0].title).toBe(
      "GET /api/admin/metrics without auth check — handler returns only hardcoded values"
    );
    expect(a.categories.security.score).toBe(6);
    expect(a.capsApplied.join(" ")).toMatch(/reconciliation/i);
    expect(a.capsApplied.join(" ")).toMatch(/6\/10/);
    // Pure: the input report is untouched.
    expect(pf.findings[0].severity).toBe("critical");
    expect(pf.findings[0].title).toBe("GET /api/admin/metrics without auth check");
  });

  it("9. leaves the no-auth finding critical (Security cap 4) when the handler is real", () => {
    const pf = preflightWith([noAuthFinding()]);
    const a = computeDeterministicAssessment([wf("server.ts", REAL_SERVER)], pf);
    expect(fabricatedFindings(a)).toHaveLength(0);
    expect(a.calibratedPreflightFindings[0].severity).toBe("critical");
    expect(a.calibratedPreflightFindings[0].title).toBe("GET /api/admin/metrics without auth check");
    expect(a.categories.security.score).toBe(4);
  });
});
