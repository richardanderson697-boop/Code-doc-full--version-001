// Regression tests for the Claude-audited report fixes (2026-10-04):
// line-count off-by-one, CAP A package.json gate, deterministic import map,
// imported-but-empty files, and mock-declaration noise in mock data files.
import { describe, it, expect } from "vitest";
import {
  computeDeterministicAssessment,
  formatAssessmentForPrompt,
  extractImports,
  resolveWorkspaceImport,
} from "../server/deterministic-score";
import { runDeterministicScan } from "../server/deterministic-scan";
import { countLines } from "../server/workspace";
import type { PreFlightReport } from "../shared/preflight-types";
import type { WorkspaceFile } from "../server/workspace";

function wf(path: string, content: string): WorkspaceFile {
  return { path, content, lineCount: countLines(content) };
}

function emptyPreflight(): PreFlightReport {
  return {
    engine: "PreFlight",
    probeCount: 113,
    filesScanned: 1,
    filesSkipped: [],
    score: 100,
    counts: {},
    findings: [],
    probeFailures: [],
    failed: null,
  };
}

describe("countLines", () => {
  it("reports 0 for an empty file", () => {
    expect(countLines("")).toBe(0);
  });
  it("does not count a trailing newline as a line", () => {
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a")).toBe(1);
  });
});

describe("mock-declaration noise", () => {
  it("does not flag MOCK_ declarations inside mock data files", () => {
    const s = runDeterministicScan("export const MOCK_TENANTS: Tenant[] = [];\n", "src/utils/mockData.ts");
    expect(s.stubs).toHaveLength(0);
  });
  it("still flags mock declarations in ordinary files", () => {
    const s = runDeterministicScan("const mockUsers = [];\n", "src/data.ts");
    expect(s.stubs.length).toBeGreaterThan(0);
  });
  it("still flags simulated comments in mock data files", () => {
    const s = runDeterministicScan("// Simulated payout ledger\nconst x = 1;\n", "src/utils/mockData.ts");
    expect(s.stubs.length).toBeGreaterThan(0);
  });
});

describe("extractImports", () => {
  it("extracts static, type, side-effect, export-from, require and dynamic imports", () => {
    const code = `import React from 'react';
import { a } from "./a";
import type { T } from '../types';
import './polyfill';
export { x } from "./x";
export * from '../y';
const z = require("z-lib");
const w = await import("./w");
// import { commented } from "./nope";
`;
    expect(extractImports(code)).toEqual([
      "react",
      "./a",
      "../types",
      "./polyfill",
      "./x",
      "../y",
      "z-lib",
      "./w",
    ]);
  });
  it("handles multi-line import blocks", () => {
    const code = `import {\n  a,\n  b,\n} from './multi';\n`;
    expect(extractImports(code)).toEqual(["./multi"]);
  });
});

describe("resolveWorkspaceImport", () => {
  const known = new Set(["src/a/x.ts", "src/a/y/index.tsx", "src/b.ts"]);
  it("resolves relative specifiers with extension probing", () => {
    expect(resolveWorkspaceImport("src/a/b.ts", "./x", known)).toBe("src/a/x.ts");
    expect(resolveWorkspaceImport("src/a/b.ts", "./y", known)).toBe("src/a/y/index.tsx");
    expect(resolveWorkspaceImport("src/a/b.ts", "../b", known)).toBe("src/b.ts");
  });
  it("returns null for bare specifiers and unknown paths", () => {
    expect(resolveWorkspaceImport("src/a/b.ts", "react", known)).toBeNull();
    expect(resolveWorkspaceImport("src/a/b.ts", "./missing", known)).toBeNull();
  });
});

describe("CAP A without package.json", () => {
  it("caps a doorless React frontend at 30 even with no package.json", () => {
    const files = [
      wf("src/App.tsx", `import React from 'react';\nimport { Foo } from './Foo';\nexport function App() { return <Foo/>; }\n`),
      wf("src/Foo.tsx", `import React from 'react';\nexport function Foo() { return <div/>; }\n`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.completenessScore).toBeLessThanOrEqual(30);
    expect(a.capsApplied.some((c) => c.includes("CAP A"))).toBe(true);
  });
});

describe("imported-but-empty files", () => {
  it("flags an empty file that another file imports", () => {
    const files = [
      wf("src/App.tsx", `import { InventoryManager } from './components/InventoryManager';\nexport function App() { return null; }\n`),
      wf("src/components/InventoryManager.tsx", ""),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    const hit = a.missingFeatures.find((m) => m.feature.includes("src/components/InventoryManager.tsx"));
    expect(hit).toBeDefined();
    expect(hit!.feature).toContain("breaks the build");
    expect(hit!.evidence.join(" ")).toContain("src/App.tsx");
  });
  it("does not flag empty files nobody imports", () => {
    const files = [
      wf("src/App.tsx", `export function App() { return null; }\n`),
      wf("src/unused.ts", ""),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.missingFeatures.some((m) => m.feature.includes("src/unused.ts"))).toBe(false);
  });
});

describe("import map ground truth", () => {
  it("renders a deterministic per-file import map in the prompt block", () => {
    const files = [
      wf("src/App.tsx", `import React from 'react';\nimport { Foo } from './Foo';\n`),
      wf("src/Foo.tsx", `export function Foo() { return null; }\n`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    const block = formatAssessmentForPrompt(a);
    expect(block).toContain("Import map (deterministic");
    expect(block).toContain("- src/App.tsx: react | ./Foo");
    expect(block).toContain("- src/Foo.tsx: (no imports)");
  });
});
