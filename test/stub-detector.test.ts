// Stub-detector accuracy tests.
// Spec: October 28 stub-detector spec (TODO lead-anchor + trailing word
// boundary on `const mock` / `const temp`), same-day add-on extending the
// lead-anchor to section 3, plus the 2026-11-08 addendum (test-file
// exemption for section 3). Addendum:
// stub-detector-spec-2026-11-08-addendum.md.
// The motivating case is the 2026-11-08 GradeVibes self-assessment
// (70/100): six of the seven named stub/TODO items were the detector
// flagging its own vocabulary, and the seventh was a TODO inside a test
// fixture.
import { describe, it, expect } from "vitest";
import { runDeterministicScan } from "../server/deterministic-scan";

function scan(code: string, filePath = "src/example.ts") {
  return runDeterministicScan(code, filePath);
}

describe("trailing word boundary on const mock / const temp", () => {
  it("does not flag `const temperature` (anthropic.ts:77, self-scan 2026-11-08)", () => {
    const a = scan(`const temperature =\n  typeof cfg.temperature === "number"\n    ? Math.min(Math.max(cfg.temperature, 0), 1)\n    : undefined;\n`);
    expect(a.stubs).toHaveLength(0);
  });

  it("does not flag `const mocked:` (deterministic-score.ts:1122, Nov 7 mocked-payments code)", () => {
    const a = scan(`const mocked: { path: string; line: string; code: string }[] = [];\nfor (const f of sig.files) {\n  for (const m of f.analysis.mockedPayments) {\n  }\n}\n`);
    expect(a.stubs).toHaveLength(0);
  });

  it("does not flag Solitaire game variables `const tempDeck` / `const tempCols`", () => {
    const a = scan(`const tempDeck = shuffle(deck);\nconst tempCols = columns.map((c) => [...c]);\n`);
    expect(a.stubs).toHaveLength(0);
  });

  it("still flags a bare `const mock` and a bare `const temp`", () => {
    expect(scan(`const mock = { user: "x" };\n`).stubs).toHaveLength(1);
    expect(scan(`const temp = 1;\n`).stubs).toHaveLength(1);
  });

  it("still flags a declared named fixture, but not a bare use of one", () => {
    expect(scan(`const mockUsers = [{ id: 1 }];\n`).stubs).toHaveLength(1);
    expect(scan(`mockUsers.push({ id: 2 });\n`).stubs).toHaveLength(0);
  });

  it("does not flag the rule's own definition line (named list as regex source)", () => {
    const line = `const isMockDeclaration = !isMockDataFile && !isTestFile && (/\\b(const|let|var)\\s+(mockData|mockUsers|mockTodos|mockEvents|tempData)\\b/i.test(line) || /\\bconst\\s+mock\\b/i.test(line) || /\\bconst\\s+temp\\b/i.test(line));\n`;
    expect(scan(line).stubs).toHaveLength(0);
  });
});

describe("TODO lead-anchor (section 3 + section 5)", () => {
  it("does not flag the detector's own definitional comment (deterministic-scan.ts:459/462)", () => {
    const code = [
      "// 5. Stubs / Mocks",
      '// A file whose whole job is mock/fixture/seed data is not "unfinished"',
      "// because it declares const MOCK_*: flagging it is pure noise.",
      '// NOTE: bare keywords ("mock", "simulated", ...) in *comments* are not',
      "// stubs — a comment describing simulated data is documentation, not",
      "// unfinished code. Only an explicit TODO: implement marker in a comment",
      "// counts as a stub signal, and the marker must lead the comment — a",
      "// mid-sentence mention does not count.",
    ].join("\n") + "\n";
    const a = scan(code, "server/deterministic-scan.ts");
    expect(a.stubs).toHaveLength(0);
    expect(a.todos).toHaveLength(0);
  });

  it("still flags a real `// TODO: implement ...` comment as both stub and todo", () => {
    const a = scan(`// TODO: implement the retry logic\n`);
    expect(a.stubs).toHaveLength(1);
    expect(a.todos).toHaveLength(1);
  });

  it("does not flag `// Add Todo Evidence` (cold-audit.ts:151 — Todo is the second word)", () => {
    const a = scan(`// Add Todo Evidence\nscan.todos.forEach(item => {\n  if (!parsedData.evidence.some((e) => e.lines === item.lines)) {\n  }\n});\n`);
    expect(a.todos).toHaveLength(0);
  });

  it("does not flag prose ending in the word bug (finalread-qa.ts:569 shape)", () => {
    const code = [
      "/* charged partial once asserted \"the review does not detail\" native",
      " * browser speech while the full review's ledger detailed SpeechSynthesis",
      " * in the player — the serious shape of this bug. */",
      "export const PARTIAL_SCOPE_GUIDANCE = \"When the review establishes only part of an answer\";",
    ].join("\n") + "\n";
    expect(scan(code, "shared/finalread-qa.ts").todos).toHaveLength(0);
  });

  it("does not flag a TODO inside a test fixture (preflight-auth-calibration.test.ts:165)", () => {
    const code = [
      "const fakeRoute = {",
      '  path: "app/api/settings/route.ts",',
      "  content: `",
      "// TODO: add auth check before launch",
      "export async function POST(req: Request) {",
      "  const body = await req.json();",
      "}` ,",
      "};",
    ].join("\n") + "\n";
    const a = scan(code, "test/preflight-auth-calibration.test.ts");
    expect(a.todos).toHaveLength(0);
  });

  it("still flags a real leading TODO in production code", () => {
    expect(scan(`// TODO: add retry\n`).todos).toHaveLength(1);
    expect(scan(`// FIXME: handle null\n`).todos).toHaveLength(1);
  });

  it("does not flag a TODO mentioned mid-sentence in a comment", () => {
    expect(scan(`// NOTE: this has a TODO inside\n`).todos).toHaveLength(0);
  });
});
