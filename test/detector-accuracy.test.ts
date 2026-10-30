// Detector accuracy fixes (Fix A comment-blind matching, Fix B declared
// design, IndexedDB recall): the Room 2 Room zip is the motivating case.
// AnnouncementComposer.tsx:184 is a JSX comment, server.ts:10 is a design
// declaration, db.ts is real IndexedDB — the scan must now tell those
// apart from real references, real gaps, and real implementations.
import { describe, it, expect } from "vitest";
import {
  computeDeterministicAssessment,
  splitCodeAndComments,
  extractDesignDeclarations,
} from "../server/deterministic-score";
import type { PreFlightReport } from "../shared/preflight-types";
import type { WorkspaceFile } from "../server/workspace";

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

describe("splitCodeAndComments", () => {
  it("blanks line comments and preserves line numbers", () => {
    const content = "const a = 1;\n// LOG IN here\nconst b = signIn();\n";
    const { code, comments } = splitCodeAndComments(content);
    const lines = code.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1].trim()).toBe("");
    expect(lines[2]).toContain("signIn()");
    expect(code).not.toContain("LOG IN");
    expect(comments).toEqual([{ line: 2, text: "LOG IN here" }]);
  });

  it("blanks multi-line block comments without collapsing lines", () => {
    const content = "/*\nLOG IN\n*/\nconst x = 1;\n";
    const { code, comments } = splitCodeAndComments(content);
    expect(code.split("\n")).toHaveLength(5);
    expect(code.split("\n")[3]).toContain("const x = 1;");
    expect(code).not.toContain("LOG IN");
    expect(comments[0].line).toBe(1);
    expect(comments[0].text).toBe("LOG IN");
  });

  it("blanks JSX comments", () => {
    const content = "export function C() { return (<div>{/* AUDIT LOG IN STAFF MODE ONLY */}</div>); }\n";
    const { code, comments } = splitCodeAndComments(content);
    expect(code).not.toContain("AUDIT");
    expect(comments[0].text).toBe("AUDIT LOG IN STAFF MODE ONLY");
  });

  it("preserves string and template literals", () => {
    const content = 'const u = "http://example.com";\nconst label = "Log in";\nconst t = `see // here`;\n';
    const { code } = splitCodeAndComments(content);
    expect(code).toContain("http://example.com");
    expect(code).toContain('"Log in"');
    expect(code).toContain("// here");
  });

  it("blanks HTML comments and keeps division intact", () => {
    const { code: htmlCode } = splitCodeAndComments("<!-- database notes -->\n<p>hi</p>\n");
    expect(htmlCode).not.toContain("database notes");
    const { code: divCode } = splitCodeAndComments("const r = x / 2; // real comment\n");
    expect(divCode).toContain("const r = x / 2;");
    expect(divCode).not.toContain("real comment");
  });
});

describe("Fix A: comment-blind reference matching", () => {
  it("a comment-only LOG IN is not an auth reference (AnnouncementComposer shape)", () => {
    const files = [
      wf(
        "src/components/AnnouncementComposer.tsx",
        "export function AnnouncementComposer() { return (<div>{/* AUDIT LOG IN STAFF MODE ONLY */}<h3>Historic Announcements</h3></div>); }\n"
      ),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.applicable).toBe(false);
    expect(a.categories.authentication.note).toBe("not-applicable");
    expect(a.categories.authentication.note).not.toBe("dangling-auth");
  });

  it("a real Log in button still references auth (JSX text is code, not a comment)", () => {
    const files = [
      wf(
        "src/components/Login.tsx",
        "export function Login() { return (<button>Log in</button>); }\n"
      ),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.score).toBe(2);
    expect(a.categories.authentication.note).toBe("dangling-auth");
  });

  it("a comment-only database mention is not a db reference", () => {
    const files = [
      wf(
        "server/notes.ts",
        "// Database migration notes: consider later\nexport const x = 1;\n"
      ),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.databaseLayer.applicable).toBe(false);
    expect(a.categories.databaseLayer.note).toBe("not-applicable");
    expect(a.categories.databaseLayer.note).not.toBe("dangling-db");
  });

  it("a real TODO comment still flags (stub rules keep raw comments)", () => {
    const files = [wf("src/a.ts", "// TODO: implement the thing\nexport const x = 1;\n")];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.missingFeatures.map((m) => m.feature)).toContain("Resolve TODO in src/a.ts");
  });
});

describe("Fix B: declared design", () => {
  it("an IN-MEMORY DATABASE comment yields DB row-3, not dangling", () => {
    const files = [
      wf(
        "server.ts",
        "// IN-MEMORY DATABASE (Zero PII, stores only room, bed, avatar)\nexport const x = 1;\n"
      ),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    const cat = a.categories.databaseLayer;
    expect(cat.applicable).toBe(false);
    expect(cat.note).toBe("excluded-by-design");
    expect(cat.designDeclaration).toMatch(/IN-MEMORY DATABASE/);
    expect(cat.evidence.join(" ")).toMatch(/server\.ts:1/);
  });

  it("a NO AUTHENTICATION comment yields auth row-3", () => {
    const files = [
      wf("server.ts", "// NO AUTHENTICATION BY DESIGN\nexport const x = 1;\n"),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    const cat = a.categories.authentication;
    expect(cat.applicable).toBe(false);
    expect(cat.note).toBe("excluded-by-design");
    expect(cat.designDeclaration).toMatch(/NO AUTHENTICATION/);
  });

  it("positive evidence beats a declaration (IndexedDB + in-memory note)", () => {
    const files = [
      wf(
        "server.ts",
        "// IN-MEMORY DATABASE (Zero PII)\nexport const x = 1;\n"
      ),
      wf(
        "src/db.ts",
        "export function openDatabase(): Promise<IDBDatabase> { const request = indexedDB.open(\"AppDB\", 1); return new Promise(() => {}); }\n"
      ),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    const cat = a.categories.databaseLayer;
    expect(cat.applicable).not.toBe(false);
    expect(cat.evidence.join(" ")).toMatch(/design declared/);
  });

  it("extractDesignDeclarations reads README lines too", () => {
    const decls = extractDesignDeclarations([
      {
        path: "README.md",
        content: "# App\nNo database by design.\n",
        comments: [],
      },
    ]);
    expect(decls).toHaveLength(1);
    expect(decls[0].category).toBe("databaseLayer");
    expect(decls[0].line).toBe(2);
  });
});

describe("IndexedDB recall", () => {
  it("raw IndexedDB usage implements the database layer", () => {
    const files = [
      wf(
        "src/db.ts",
        "export function openDatabase(): Promise<IDBDatabase> { const request = indexedDB.open(\"Room2RoomConnectDB\", 1); return new Promise(() => {}); }\n"
      ),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    const cat = a.categories.databaseLayer;
    expect(cat.applicable).not.toBe(false);
    expect(cat.score).toBe(8);
    expect(cat.evidence.join(" ")).toMatch(/database client usage/);
  });
});
