// Opengrep layer tests. The binary is optional: tests that need it skip when
// it is absent (local dev without the install step, offline CI), so the suite
// stays green either way. Properties asserted: findings shape, project-
// relative paths, severity validity, graceful degradation, never-throw.
import { describe, it, expect } from "vitest";
import {
  runOpengrepScan,
  resolveOpengrepBinary,
  resolveRulesDir,
  OPENGREP_VERSION,
} from "../server/preflight/opengrep/runner";
import { runPreFlightScan } from "../server/preflight-scan";
import { SEVERITY_ORDER } from "../shared/preflight-types";

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

const BINARY = resolveOpengrepBinary();
const RULES = resolveRulesDir();
const HAVE_ENGINE = Boolean(BINARY && RULES);

describe("opengrep runner: availability", () => {
  it("resolves without throwing, in any environment", () => {
    expect(() => resolveOpengrepBinary()).not.toThrow();
    expect(() => resolveRulesDir()).not.toThrow();
  });

  it("degrades silently when disabled via OPENGREP_DISABLED", () => {
    process.env.OPENGREP_DISABLED = "1";
    try {
      const r = runOpengrepScan([{ path: "a.js", content: VULNERABLE }]);
      expect(r.findings).toEqual([]);
      expect(r.failure).toBeNull();
    } finally {
      delete process.env.OPENGREP_DISABLED;
    }
  });
});

describe.runIf(HAVE_ENGINE)("opengrep runner: detection", () => {
  it("finds the hardcoded secret and the eval sink with evidence", () => {
    const r = runOpengrepScan([{ path: "user-app/server.js", content: VULNERABLE }]);
    expect(r.failure).toBeNull();
    const probes = r.findings.map((f) => f.probe);
    expect(probes).toContain("opengrep:gv-hardcoded-secret");
    expect(probes).toContain("opengrep:gv-eval-call");
    const secret = r.findings.find((f) => f.probe === "opengrep:gv-hardcoded-secret")!;
    expect(secret.severity).toBe("critical");
    expect(secret.file).toBe("user-app/server.js");
    expect(secret.line).toBe(3);
    expect(secret.cwe).toMatch(/CWE-798/);
    expect(secret.owasp?.length).toBeGreaterThan(0);
    expect(secret.remediation).toMatch(/environment variable/i);
  });

  it("reports project-relative paths, never the temp staging dir", () => {
    const r = runOpengrepScan([{ path: "src/nested/app.ts", content: VULNERABLE }]);
    for (const f of r.findings) {
      expect(f.file).not.toMatch(/preflight-opengrep-/);
      expect(f.file.startsWith("src/nested/app.ts")).toBe(true);
    }
  });

  it("emits only known severities", () => {
    const r = runOpengrepScan([{ path: "a.js", content: VULNERABLE }]);
    for (const f of r.findings) {
      expect(SEVERITY_ORDER).toContain(f.severity);
    }
  });

  it("finds nothing in clean code", () => {
    const r = runOpengrepScan([{ path: "src/clean.ts", content: CLEAN }]);
    expect(r.failure).toBeNull();
    expect(r.findings).toEqual([]);
  });

  it("never throws on hostile paths and never escapes the staging dir", () => {
    const r = runOpengrepScan([
      { path: "../../escape.js", content: VULNERABLE },
      { path: "/absolute.js", content: VULNERABLE },
      { path: "ok.js", content: CLEAN },
    ]);
    expect(r.failure).toBeNull();
    for (const f of r.findings) {
      expect(f.file).not.toContain("..");
    }
  });
});

describe.runIf(HAVE_ENGINE)("opengrep via runPreFlightScan", () => {
  it("merges opengrep findings with the engine's, sorted by severity", () => {
    const r = runPreFlightScan([{ path: "user-app/server.js", content: VULNERABLE }]);
    expect(r.failed).toBeNull();
    expect(r.probeFailures).toEqual([]);
    const og = r.findings.filter((f) => f.probe.startsWith("opengrep:"));
    expect(og.length).toBeGreaterThan(0);
    // Engine findings still present alongside.
    expect(r.findings.some((f) => !f.probe.startsWith("opengrep:"))).toBe(true);
    const ranks = r.findings.map((f) => SEVERITY_ORDER.indexOf(f.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("keeps a clean scan clean", () => {
    const r = runPreFlightScan([{ path: "src/clean.ts", content: CLEAN }]);
    expect(r.findings).toEqual([]);
    expect(r.failed).toBeNull();
  });
});
