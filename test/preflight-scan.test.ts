// The PreFlight adapter is the containment boundary between a third-party
// engine and an async Express handler. These tests assert the properties that
// boundary has to hold, not that the code is shaped the way it is shaped.
import { describe, it, expect } from "vitest";
import {
  runPreFlightScan,
  formatFindingsForPrompt,
  MAX_FILE_BYTES,
  MAX_LINE_CHARS,
  MAX_FILES,
} from "../server/preflight-scan";
import { SEVERITY_ORDER, isScanIncomplete } from "../shared/preflight-types";

const VULNERABLE = `import express from 'express';
const app = express();
const API_KEY = 'sk-proj-abcdef1234567890abcdef1234567890abcdef12';
app.get('/run', (req, res) => {
  const cmd = req.query.cmd;
  eval(cmd);
  res.send('<h1>' + req.query.name + '</h1>');
});
app.listen(3000);
`;

const CLEAN = `export function add(a: number, b: number): number {
  return a + b;
}
`;

// A loopback-bound server plus HTML: this trips the engine's single-user-local
// app shape, which re-weights severities after the engine has already sorted,
// leaving its output genuinely out of order.
const UNSORTED_CORPUS = [
  {
    path: "server.js",
    content: `const express = require('express');
const app = express();
const API_KEY = 'sk-proj-abcdef1234567890abcdef1234567890abcdef12';
app.get('/x', (req, res) => { res.send('<h1>' + req.query.n + '</h1>'); });
app.listen(3000, '127.0.0.1');
`,
  },
  {
    path: "index.html",
    content: '<html><head><title>t</title></head><body><div>hi</div><img src="a.png"></body></html>',
  },
  {
    path: "src/App.jsx",
    content: `export default function App(){
  const t = localStorage.getItem('token');
  document.cookie = 'a=b';
  return <div onClick={() => eval(t)}>x</div>;
}
`,
  },
  { path: "package.json", content: '{"name":"x","version":"1.0.0","dependencies":{}}' },
];

describe("runPreFlightScan: detection", () => {
  it("finds the hardcoded key, the eval sink, and the XSS sink", () => {
    const r = runPreFlightScan([{ path: "user-app/server.ts", content: VULNERABLE }]);
    const titles = r.findings.map((f) => `${f.probe}: ${f.title}`).join(" | ");
    expect(titles).toMatch(/Secret Scanner/i);
    expect(titles).toMatch(/eval|Code Injection|Taint/i);
    expect(titles).toMatch(/XSS/i);
  });

  it("anchors the hardcoded key to the line it is actually on", () => {
    const r = runPreFlightScan([{ path: "user-app/server.ts", content: VULNERABLE }]);
    const secret = r.findings.find((f) => /Secret Scanner/i.test(f.probe));
    expect(secret?.line).toBe(3);
    expect(secret?.file).toBe("user-app/server.ts");
  });

  it("scores clean code above vulnerable code", () => {
    const clean = runPreFlightScan([{ path: "src/clean.ts", content: CLEAN }]);
    const vuln = runPreFlightScan([{ path: "user-app/server.ts", content: VULNERABLE }]);
    expect(clean.score).toBeGreaterThan(vuln.score);
  });

  it("attributes findings to the right file in a multi-file scan", () => {
    const r = runPreFlightScan([
      { path: "src/clean.ts", content: CLEAN },
      { path: "user-app/server.ts", content: VULNERABLE },
    ]);
    expect(r.filesScanned).toBe(2);
    expect(r.findings.find((f) => /Secret Scanner/i.test(f.probe))?.file).toBe("user-app/server.ts");
  });
});

describe("runPreFlightScan: containment", () => {
  // A malformed .preflight.json in scanned input makes the engine's own
  // suppression parser throw, outside its per-probe try/catch. Before this was
  // contained, that rejection escaped an async route handler and killed the
  // process. The scan must degrade, never throw.
  const MALFORMED_CONFIG = '{"schema":"preflight/v1","suppress":[{"probe":"Secret Scanner","title-pattern":1}]}';

  it("does not throw when the engine throws on a malformed repo config", () => {
    expect(() =>
      runPreFlightScan([
        { path: "src/App.tsx", content: VULNERABLE },
        { path: ".preflight.json", content: MALFORMED_CONFIG },
      ])
    ).not.toThrow();
  });

  it("reports the failure instead of returning a misleading clean report", () => {
    const r = runPreFlightScan([
      { path: "src/App.tsx", content: VULNERABLE },
      { path: ".preflight.json", content: MALFORMED_CONFIG },
    ]);
    expect(r.failed).toBeTruthy();
    expect(r.findings).toEqual([]);
    expect(isScanIncomplete(r)).toBe(true);
  });

  it("does not throw on malformed or hostile file entries", () => {
    const inputs: any[] = [
      [{ path: "a.ts", content: null }],
      [{ path: null, content: "x" }],
      [{}],
      [null],
      "not an array",
      null,
    ];
    for (const input of inputs) {
      expect(() => runPreFlightScan(input)).not.toThrow();
    }
  });

  it("returns a well-formed empty report for an empty file list", () => {
    const r = runPreFlightScan([]);
    expect(r.filesScanned).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.failed).toBeNull();
  });
});

describe("runPreFlightScan: input limits", () => {
  it("skips a file over the size cap and says why", () => {
    const big = "a\n".repeat(MAX_FILE_BYTES); // comfortably over the byte cap
    const r = runPreFlightScan([{ path: "big.ts", content: big }]);
    expect(r.filesScanned).toBe(0);
    expect(r.filesSkipped[0].path).toBe("big.ts");
    expect(r.filesSkipped[0].reason).toMatch(/per-file scan limit/);
  });

  it("skips a single pathologically long line, the quadratic-backtracking trigger", () => {
    // Under the byte cap but one enormous line: this is the shape that made a
    // single request block the event loop for minutes.
    const oneLine = "a".repeat(MAX_LINE_CHARS + 1);
    expect(Buffer.byteLength(oneLine)).toBeLessThan(MAX_FILE_BYTES);
    const r = runPreFlightScan([{ path: "min.js", content: oneLine }]);
    expect(r.filesScanned).toBe(0);
    expect(r.filesSkipped[0].reason).toMatch(/longest line/);
  });

  it("completes a worst-case allowed input quickly", () => {
    // Right at the limits, the scan must still finish in seconds, not minutes.
    const line = "const x = fetch('/api/a'); // padding\n";
    const content = line.repeat(Math.floor(MAX_FILE_BYTES / line.length) - 1);
    const started = Date.now();
    runPreFlightScan([{ path: "big-but-legal.ts", content }]);
    expect(Date.now() - started).toBeLessThan(15000);
  });

  it("caps the file count and records the overflow", () => {
    const files = Array.from({ length: MAX_FILES + 5 }, (_, i) => ({
      path: `src/f${i}.ts`,
      content: CLEAN,
    }));
    const r = runPreFlightScan(files);
    expect(r.filesScanned).toBeLessThanOrEqual(MAX_FILES);
    expect(r.filesSkipped.length).toBeGreaterThan(0);
    expect(r.filesSkipped.some((s) => /file limit/.test(s.reason))).toBe(true);
  });

  it("accounts for every file given, across a scanned/skipped mixture", () => {
    // One file per exclusion reason plus two that pass, so the accounting is
    // exercised rather than asserting 1 + 0 === 1.
    const files = [
      { path: "ok1.ts", content: CLEAN },
      { path: "ok2.ts", content: CLEAN },
      { path: "big.ts", content: "a\n".repeat(MAX_FILE_BYTES) },
      { path: "minified.js", content: "a".repeat(MAX_LINE_CHARS + 1) },
      { path: "bad.ts", content: null as any },
    ];
    const r = runPreFlightScan(files);
    expect(r.filesScanned).toBe(2);
    expect(r.filesSkipped).toHaveLength(3);
    expect(r.filesScanned + r.filesSkipped.length).toBe(files.length);
    expect(r.filesSkipped.map((s) => s.path).sort()).toEqual(["bad.ts", "big.ts", "minified.js"]);
  });
});

describe("runPreFlightScan: report contract", () => {
  it("orders findings by severity, most severe first", () => {
    // The engine sorts, then re-weights exposure-dependent findings for a
    // single-user local app WITHOUT re-sorting, so its output really is out of
    // order for this corpus (verified: a high lands after a medium, and lows
    // after infos). The adapter has to restore the order, because the prompt
    // digest caps on it and would otherwise spend its budget on info findings
    // while dropping highs.
    const r = runPreFlightScan(UNSORTED_CORPUS);
    expect(r.findings.length).toBeGreaterThan(10);
    const ranks = r.findings.map((f) => SEVERITY_ORDER.indexOf(f.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  // Coercion, OWASP normalization, and probe-failure exposure are covered in
  // adapter-coercion.test.ts, which drives a fake engine. Against the real
  // engine those branches never execute, so assertions here could not fail.
  // What belongs at this level is that the real engine stays inside the
  // contract: no probe breaks on this corpus, and nothing needs coercing.
  it("scans this corpus with no probe failures and no coerced severities", () => {
    const r = runPreFlightScan([{ path: "user-app/server.ts", content: VULNERABLE }]);
    expect(r.probeFailures).toEqual([]);
    expect(r.findings.filter((f) => f.originalSeverity !== undefined)).toEqual([]);
    expect(r.failed).toBeNull();
  });
});

describe("formatFindingsForPrompt", () => {
  it("lists the real findings with file and line anchors", () => {
    const r = runPreFlightScan([{ path: "user-app/server.ts", content: VULNERABLE }]);
    expect(r.findings.length).toBeGreaterThan(0);
    const digest = formatFindingsForPrompt(r);
    expect(digest).toMatch(/ground truth/i);
    expect(digest).toContain("user-app/server.ts:3");
    for (const f of r.findings.slice(0, 40)) {
      expect(digest).toContain(f.title);
    }
  });

  it("caps the digest and states how many it dropped", () => {
    const r = runPreFlightScan([{ path: "user-app/server.ts", content: VULNERABLE }]);
    expect(r.findings.length).toBeGreaterThan(2);
    const digest = formatFindingsForPrompt(r, 2);
    expect(digest.split("\n").filter((l) => l.startsWith("- ["))).toHaveLength(2);
    expect(digest).toMatch(/more findings omitted/);
  });

  it("keeps the most severe findings when it caps", () => {
    // Asserting the digest contains findings[0] is true by construction at any
    // sort order. Assert the severity that survives instead.
    const r = runPreFlightScan(UNSORTED_CORPUS);
    const digest = formatFindingsForPrompt(r, 1);
    const kept = digest.split("\n").filter((l) => l.startsWith("- ["));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("[CRITICAL]");
  });

  it("spends its cap on severe findings, not on info ones", () => {
    // The corpus the engine returns out of order: capping an unsorted list
    // would hand the model info-level SEO findings while dropping a high.
    const r = runPreFlightScan(UNSORTED_CORPUS);
    const severeCount = r.findings.filter((f) =>
      ["critical", "high"].includes(f.severity)
    ).length;
    expect(severeCount).toBeGreaterThan(0);
    const digest = formatFindingsForPrompt(r, severeCount);
    expect(digest).not.toMatch(/\[INFO\]/);
    for (const f of r.findings.filter((x) => ["critical", "high"].includes(x.severity))) {
      expect(digest).toContain(f.title);
    }
  });

  it("tells the model not to invent issues only when the scan really was clean", () => {
    const r = runPreFlightScan([{ path: "src/clean.ts", content: CLEAN }]);
    expect(r.findings).toEqual([]);
    expect(r.failed).toBeNull();
    expect(r.probeFailures).toEqual([]);
    const digest = formatFindingsForPrompt(r);
    expect(digest).toMatch(/do not invent/i);
  });

  it("says 'not measured' rather than 'clean' when the scan failed", () => {
    const r = runPreFlightScan([
      { path: "src/App.tsx", content: VULNERABLE },
      {
        path: ".preflight.json",
        content: '{"schema":"preflight/v1","suppress":[{"probe":"Secret Scanner","title-pattern":1}]}',
      },
    ]);
    const digest = formatFindingsForPrompt(r);
    expect(digest).toMatch(/not measured/i);
    expect(digest).not.toMatch(/do not invent/i);
  });
});

describe("probeWeakRandomness: benign identifiers are not secrets", () => {
  it("does not flag Math.random() assigned to a label (unique label, not a secret)", () => {
    const r = runPreFlightScan([
      {
        path: "server.ts",
        content: `const label = 'item-' + Math.random().toString(36).slice(2);\nconsole.log(label);\n`,
      },
    ]);
    expect(r.findings.filter((f) => f.probe === "Weak Randomness")).toHaveLength(0);
  });

  it("still flags Math.random() assigned to a token", () => {
    const r = runPreFlightScan([
      {
        path: "server.ts",
        content: `const token = Math.random().toString(36).slice(2);\nconsole.log(token);\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "Weak Randomness");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].severity).toBe("high");
  });

  it("suppresses Math.random() when the literal declares a reset marker", () => {
    // SecureToken case: last_session_id: 'RESET_SYSTEM_' + Date.now() + '_' +
    // Math.random() — a reset tombstone, not a secret. The window check would
    // otherwise match the word "reset" in the marker against itself.
    const r = runPreFlightScan([
      {
        path: "server.ts",
        content: `app.post('/api/reset-credits', async (req, res) => {\n  const q = db.update({ last_session_id: 'RESET_SYSTEM_' + Date.now() + '_' + Math.random().toString(36).substring(7) });\n  res.json({ ok: true });\n});\n`,
      },
    ]);
    expect(r.findings.filter((f) => f.probe === "Weak Randomness")).toHaveLength(0);
  });

  it("still fires when a security-named LHS uses a marker literal", () => {
    // The marker suppression never overrides the strong LHS signal:
    // const resetToken = 'reset_' + Math.random() is a predictable credential.
    const r = runPreFlightScan([
      {
        path: "server.ts",
        content: `const resetToken = 'reset_' + Math.random().toString(36).slice(2);\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "Weak Randomness");
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("probeSupabaseServiceRole: admin client bypasses RLS", () => {
  const PKG = `{ "dependencies": { "@supabase/supabase-js": "^2.0.0" } }`;

  it("flags a backend service_role client as medium (verify route auth)", () => {
    const r = runPreFlightScan([
      { path: "package.json", content: PKG },
      {
        path: "server/db.ts",
        content: `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(process.env.URL, process.env.SUPABASE_SERVICE_ROLE_KEY);\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "Supabase Service Role");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("medium");
    expect(hits[0].title).toMatch(/bypasses Row Level Security/i);
  });

  it("flags browser-exposed service_role keys as high", () => {
    const r = runPreFlightScan([
      { path: "package.json", content: PKG },
      {
        path: "src/lib/supabase.ts",
        content: `import { createClient } from '@supabase/supabase-js';\nconst admin = createClient(url, import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY);\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "Supabase Service Role");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("high");
  });

  it("catches bare assignments (lazy singletons without const/let/var)", () => {
    const r = runPreFlightScan([
      { path: "package.json", content: PKG },
      {
        path: "server.ts",
        content: `import { createClient } from '@supabase/supabase-js';\nlet inst = null;\nconst getAdmin = () => {\n  inst = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);\n  return inst;\n};\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "Supabase Service Role");
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(4);
    expect(hits[0].severity).toBe("medium");
  });

  it("treats a camelCase serviceRole variable as a definite service_role key", () => {
    // SecureToken case: supabaseAdminInstance = createClient(supabaseUrl,
    // supabaseServiceRoleKey, ...) — the variable holds the key, so the
    // title must be definite, not "verify it does not use service_role".
    const r = runPreFlightScan([
      { path: "package.json", content: PKG },
      {
        path: "server.ts",
        content: `import { createClient } from '@supabase/supabase-js';\nlet supabaseAdminInstance = null;\nsupabaseAdminInstance = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } });\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "Supabase Service Role");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toMatch(/bypasses Row Level Security/i);
    expect(hits[0].title).not.toMatch(/verify it does not use/i);
  });

  it("flags an admin-named handle as medium when the key is not service_role", () => {
    const r = runPreFlightScan([
      { path: "package.json", content: PKG },
      {
        path: "server/db.ts",
        content: `import { createClient } from '@supabase/supabase-js';\nexport const supabaseAdmin = createClient(process.env.URL, process.env.ANON_KEY);\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "Supabase Service Role");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("medium");
  });

  it("stays silent for an ordinary anon-key client", () => {
    const r = runPreFlightScan([
      { path: "package.json", content: PKG },
      {
        path: "server/db.ts",
        content: `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(process.env.URL, process.env.ANON_KEY);\n`,
      },
    ]);
    expect(r.findings.filter((f) => f.probe === "Supabase Service Role")).toHaveLength(0);
  });

  it("stays silent when the project does not use supabase", () => {
    const r = runPreFlightScan([
      { path: "server/db.ts", content: `const x = createClient(a, b);\n` },
    ]);
    expect(r.findings.filter((f) => f.probe === "Supabase Service Role")).toHaveLength(0);
  });
});

describe("probeAPIRouteAuth: per-route anchoring", () => {
  it("anchors findings at the route line, not line 1, for Express files", () => {
    const r = runPreFlightScan([
      {
        path: "server.ts",
        content: `import express from 'express';\nconst app = express();\napp.post('/api/create-checkout-session', async (req, res) => {\n  res.json({});\n});\napp.get('/api/health', (req, res) => res.send('ok'));\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "API Route Auth");
    // /api/create-checkout-session is sensitive (checkout) -> one finding at line 3.
    // /api/health is not sensitive and GET is not destructive -> no finding.
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].title).toMatch(/POST \/api\/create-checkout-session/);
    expect(hits[0].severity).toBe("critical");
  });

  it("emits one finding per unauthenticated sensitive route", () => {
    const r = runPreFlightScan([
      {
        path: "server.ts",
        content: `const app = express();\napp.post('/api/checkout', (req, res) => res.send('x'));\napp.post('/api/billing', (req, res) => res.send('y'));\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "API Route Auth");
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.line).sort()).toEqual([2, 3]);
  });

  it("keeps file-level anchoring for non-Express route files", () => {
    const r = runPreFlightScan([
      {
        path: "app/api/admin/route.ts",
        content: `export async function POST(req: Request) {\n  return Response.json({});\n}\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "API Route Auth");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].line).toBe(1);
  });

  it("stays silent when the file has an auth signal", () => {
    const r = runPreFlightScan([
      {
        path: "server.ts",
        content: `const app = express();\napp.post('/api/checkout', requireAuth, (req, res) => res.send('x'));\n`,
      },
    ]);
    expect(r.findings.filter((f) => f.probe === "API Route Auth")).toHaveLength(0);
  });

  it("flags financial routes without auth (spend/reset-credits, generate)", () => {
    // SecureToken case: /api/reset-credits and /api/spend-credits let anyone
    // zero or drain any user's balance; /api/generate is the paid endpoint.
    const r = runPreFlightScan([
      {
        path: "server.ts",
        content: `const app = express();\napp.post('/api/reset-credits', async (req, res) => {\n  const { userId } = req.body;\n  if (!userId) return res.status(401).json({ error: 'User ID required' });\n  res.json({ ok: true });\n});\napp.post('/api/spend-credits', (req, res) => res.send('x'));\napp.post('/api/generate', (req, res) => res.send('y'));\n`,
      },
    ]);
    const hits = r.findings.filter((f) => f.probe === "API Route Auth");
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.line).sort()).toEqual([2, 7, 8]);
    expect(hits[0].title).toMatch(/POST \/api\/reset-credits/);
  });
});
