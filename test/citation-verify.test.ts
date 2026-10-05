// Citation grounding ("verify citations"): every `file:line` citation in
// LLM-written report text must resolve to a real file, a real line, and
// (when code is quoted) the quoted text near that line. Unsupported
// citations are dropped; the import map is repaired from ground truth.
import { describe, it, expect } from "vitest";
import {
  verifyTextCitations,
  verifyReportCitations,
  repairImportMap,
} from "../server/citation-verify";

const FILES = [
  {
    path: "server/auth.ts",
    content: [
      "import jwt from 'jsonwebtoken';",
      "const SECRET = process.env.AUTH_SECRET;",
      "export function verify(token: string) {",
      "  return jwt.verify(token, SECRET);",
      "}",
    ].join("\n"),
  },
  { path: "src/App.tsx", content: "export default function App() {\n  return <div/>;\n}" },
];

function filesMap() {
  return new Map(
    FILES.map((f) => [f.path, { lines: f.content.split("\n"), lineCount: f.content.split("\n").length }])
  );
}

function state() {
  return { checked: 0, dropped: [] as string[] };
}

describe("verifyTextCitations", () => {
  it("keeps a valid citation with a matching quote", () => {
    const text = "Auth is verified in server/auth.ts:4 (`jwt.verify(token, SECRET)`).";
    const out = verifyTextCitations(text, filesMap(), state());
    expect(out).toContain("server/auth.ts:4");
    expect(out).toContain("jwt.verify(token, SECRET)");
  });

  it("keeps a valid citation with no quote", () => {
    const text = "See the middleware in server/auth.ts:2 for the secret handling.";
    const out = verifyTextCitations(text, filesMap(), state());
    expect(out).toContain("server/auth.ts:2");
  });

  it("drops a citation to a nonexistent file", () => {
    const st = state();
    const text = "Auth lives in server/middleware/auth.ts:8 and works fine.";
    const out = verifyTextCitations(text, filesMap(), st);
    expect(out).not.toContain("server/middleware/auth.ts:8");
    expect(st.dropped).toContain("server/middleware/auth.ts:8");
    expect(out).toContain("Auth lives in");
  });

  it("drops a citation with an out-of-range line", () => {
    const st = state();
    const text = "The handler is defined in src/App.tsx:99.";
    const out = verifyTextCitations(text, filesMap(), st);
    expect(out).not.toContain("src/App.tsx:99");
    expect(st.dropped.length).toBe(1);
  });

  it("drops a citation whose quoted code is nowhere near the cited line", () => {
    const st = state();
    const text = "The secret comes from server/auth.ts:1 (`decrypt(password, key)`).";
    const out = verifyTextCitations(text, filesMap(), st);
    // That snippet appears nowhere in the file — unsupported.
    expect(out).not.toContain("server/auth.ts:1");
    expect(out).not.toContain("decrypt(password, key)");
    expect(st.dropped.length).toBe(1);
  });

  it("leaves text without citations untouched", () => {
    const st = state();
    const text = "Authentication is implemented with JWT sessions.";
    expect(verifyTextCitations(text, filesMap(), st)).toBe(text);
    expect(st.checked).toBe(0);
  });

  it("handles the `file line N` phrasing", () => {
    const st = state();
    const text = "See server/auth.ts line 3 for the verify function.";
    const out = verifyTextCitations(text, filesMap(), st);
    expect(out).toContain("server/auth.ts line 3");
    expect(st.checked).toBe(1);
    expect(st.dropped).toEqual([]);
  });
});

describe("verifyReportCitations", () => {
  function report() {
    return {
      categoryScores: {
        authentication: {
          score: 4,
          max: 10,
          reason:
            "JWT verification exists in server/auth.ts:4 (`jwt.verify(token, SECRET)`), but server/nope.ts:2 has no checks.",
        },
        security: { score: 6, max: 10, reason: "No issues found." },
      },
      missingFeatures: [
        { feature: "Add RLS", category: "Database layer", reason: "See migrations/rls.sql:1 for the missing policy." },
      ],
      fileLedger: [
        { filePath: "server/auth.ts", lineCount: 5, description: "Auth helpers (server/auth.ts:1).", contribution: "Sessions." },
      ],
    };
  }

  const opts = {
    categoryReason: (key: string) => `Deterministic fallback for ${key}. This sentence is long enough to survive.`,
    missingReason: (feature: string) => `Flagged by deterministic scan: ${feature}. Long enough to survive fallback.`,
  };

  it("drops bad citations, keeps good ones, and counts both", () => {
    const r = report();
    const v = verifyReportCitations(r, FILES, opts);
    expect(v.citationsChecked).toBeGreaterThan(0);
    // server/nope.ts:2 and migrations/rls.sql:1 are dropped; the rest survive.
    expect(v.citationsDropped).toBe(2);
    expect(r.categoryScores.authentication.reason).toContain("server/auth.ts:4");
    expect(r.categoryScores.authentication.reason).not.toContain("server/nope.ts:2");
    expect(r.missingFeatures[0].reason).not.toContain("migrations/rls.sql:1");
    expect(r.fileLedger[0].description).toContain("server/auth.ts:1");
  });

  it("falls back when a reason collapses to nothing", () => {
    const r = report();
    r.categoryScores.security.reason = "Bad (server/nope.ts:1).";
    const v = verifyReportCitations(r, FILES, opts);
    expect(v.citationsDropped).toBeGreaterThan(0);
    expect(r.categoryScores.security.reason).toMatch(/Deterministic fallback for security/);
  });
});

describe("repairImportMap", () => {
  it("restores dropped imports from ground truth", () => {
    const report = {
      applicationMap: {
        components: [
          { name: "App", filePath: "src/App.tsx", imports: ["react"] },
          { name: "Ghost", filePath: "src/Ghost.tsx", imports: [] },
        ],
      },
    };
    const repaired = repairImportMap(report, [{ path: "src/App.tsx", imports: ["react", "react-dom", "./x"] }]);
    expect(repaired).toBe(1);
    expect(report.applicationMap.components[0].imports).toEqual(["react", "react-dom", "./x"]);
    // Unknown filePath: left untouched, never invented.
    expect(report.applicationMap.components[1].imports).toEqual([]);
  });

  it("is a no-op when the map already matches", () => {
    const report = {
      applicationMap: { components: [{ name: "A", filePath: "a.ts", imports: ["x"] }] },
    };
    expect(repairImportMap(report, [{ path: "a.ts", imports: ["x"] }])).toBe(0);
  });
});
