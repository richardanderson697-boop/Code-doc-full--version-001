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

  it("does NOT flag a bare `const mock` or a bare `const temp` (family rework 2026-11-24: identifier alone is never a signal)", () => {
    expect(scan(`const mock = { user: "x" };\n`).stubs).toHaveLength(0);
    expect(scan(`const temp = 1;\n`).stubs).toHaveLength(0);
  });

  it("does NOT flag a declared named fixture (family rework 2026-11-24: data, not unfinished code)", () => {
    expect(scan(`const mockUsers = [{ id: 1 }];\n`).stubs).toHaveLength(0);
    expect(scan(`mockUsers.push({ id: 2 });\n`).stubs).toHaveLength(0);
  });

  it("does not flag the rule's own definition lines (new signals as regex source)", () => {
    const lines = [
      `const PLACEHOLDER_PHRASE_CONTENT = /^(todo|not implemented|coming soon|placeholder)(?=$|[.,!?;:])/i;`,
      `const LOREM_IPSUM_CONTENT = /^lorem ipsum(?=$|[\\s.,!?;:])/i;`,
      `const CONSTANT_RETURN_VALUE = "(?:null|undefined|false|\\{\\s*\\}|\\[\\s*\\]|""|''|\`\`)";`,
      `const EMPTY_METHOD_RE = /\\b(?!if\\b|for\\b|while\\b|switch\\b|catch\\b|else\\b|constructor\\b)\\w+\\s*\\([^)]*\\)\\s*\\{\\s*\\}/;`,
      `  const re = /(?:\\(([^()]*)\\)|([A-Za-z_$][\\w$]*))\\s*=>\\s*\\{\\s*\\}/g;`,
    ].join("\n") + "\n";
    expect(scan(lines).stubs).toHaveLength(0);
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

describe("family rework probes (2026-11-24 spec §5 step 1 + step 2)", () => {
  it("does not flag the BookCodex swap variable `const temp = reordered[index]`", () => {
    const code = [
      "const handleMoveUp = (index: number) => {",
      "  if (index === 0) return;",
      "  const reordered = [...chapters];",
      "  const temp = reordered[index];",
      "  reordered[index] = reordered[index - 1];",
      "  reordered[index - 1] = temp;",
      "  onUpdateChapterOrder(reordered);",
      "};",
    ].join("\n") + "\n";
    expect(scan(code, "src/components/BookCodex.tsx").stubs).toHaveLength(0);
  });

  it("does not flag `const mockUsers = [{ id: 1 }];` (data, not unfinished code)", () => {
    expect(scan(`const mockUsers = [{ id: 1 }];\n`).stubs).toHaveLength(0);
  });

  it("does not flag `const tmp = a;` (the next name after temp)", () => {
    expect(scan(`const tmp = a;\n`).stubs).toHaveLength(0);
  });

  it("still flags a real `// TODO: implement ...` as 1 stub + 1 todo", () => {
    const a = scan(`// TODO: implement the retry logic\n`);
    expect(a.stubs).toHaveLength(1);
    expect(a.todos).toHaveLength(1);
  });

  it("flags an empty non-handler function body (signal D, expanded)", () => {
    expect(scan(`function onSave() {}\n`).stubs).toHaveLength(1);
    expect(scan(`const handler = () => {}\n`).stubs).toHaveLength(1);
    expect(scan(`class X {\n  save() {}\n}\n`).stubs).toHaveLength(1);
  });

  it("flags a constant-return stub (signal C)", () => {
    expect(scan(`function getUser() { return null; }\n`).stubs).toHaveLength(1);
    expect(scan(`function getItems() { return []; }\n`).stubs).toHaveLength(1);
    expect(scan(`const getUser = () => { return null; };\n`).stubs).toHaveLength(1);
  });

  it("flags a placeholder return (signal B)", () => {
    expect(scan(`function getStatus() {\n  return "coming soon";\n}\n`).stubs).toHaveLength(1);
    expect(scan(`const msg = "coming soon";\n`).stubs).toHaveLength(1);
  });

  it("does not flag a lookup returning null after a search (signal C guard)", () => {
    const code = [
      "function findUser(id) {",
      "  const u = users.find((x) => x.id === id);",
      "  return u ?? null;",
      "}",
    ].join("\n") + "\n";
    expect(scan(code).stubs).toHaveLength(0);
  });

  it("does not flag an empty-array default from real logic (signal C guard)", () => {
    const code = [
      "function getItems(filter) {",
      "  const items = all.filter(filter);",
      "  return items.length ? items : [];",
      "}",
    ].join("\n") + "\n";
    expect(scan(code).stubs).toHaveLength(0);
  });
});

describe("new signals B/C/D — guards and exclusions (family rework 2026-11-24)", () => {
  it("signal B: flags every placeholder literal in the set, any case", () => {
    expect(scan(`const a = "not implemented";\n`).stubs).toHaveLength(1);
    expect(scan(`const b = "TODO";\n`).stubs).toHaveLength(1);
    expect(scan(`const c = "placeholder";\n`).stubs).toHaveLength(1);
    expect(scan(`const d = "lorem ipsum";\n`).stubs).toHaveLength(1);
    expect(scan(`const e = "Coming Soon";\n`).stubs).toHaveLength(1);
    expect(scan(`const f = "Lorem ipsum dolor sit amet";\n`).stubs).toHaveLength(1);
  });

  it("signal B: the literal content is the signal, never the variable name", () => {
    expect(scan(`const placeholder = getRealValue();\n`).stubs).toHaveLength(0);
    expect(scan(`const todo = loadTodos();\n`).stubs).toHaveLength(0);
  });

  it("signal B: ambiguous literals do not flag (fail-closed)", () => {
    expect(scan(`const x = "test";\n`).stubs).toHaveLength(0);
    expect(scan(`const x = "xxx";\n`).stubs).toHaveLength(0);
  });

  it("signal B: does not flag a placeholder literal in a comment, a comparison, or a throw", () => {
    expect(scan(`// const msg = "coming soon"\n`).stubs).toHaveLength(0);
    expect(scan(`if (status === "coming soon") { showBadge(); }\n`).stubs).toHaveLength(0);
    expect(scan(`throw new Error("not implemented");\n`).stubs).toHaveLength(0);
  });

  it("signal B: flags a `placeholder:`-prefixed literal (accepted Tailwind edge — colon is a continuation char)", () => {
    expect(scan(`const x = "placeholder:text-gray-400";\n`).stubs).toHaveLength(1);
  });

  it("signal B: a phrase followed by a bare space is a title, not a placeholder (acceptance re-run 2026-11-24)", () => {
    // Both were false flags in the GradeVibes self-scan: a probe finding
    // title and a UI check title that merely start with a placeholder
    // phrase. A colon continuation still flags ("TODO: implement ...").
    expect(scan(`title: 'TODO or FIXME with no ticket reference',\n`).stubs).toHaveLength(0);
    expect(scan(`title: "Placeholder Operation Detected",\n`).stubs).toHaveLength(0);
    expect(scan(`const x = "TODO: implement this later";\n`).stubs).toHaveLength(1);
    expect(scan(`const x = "not implemented yet";\n`).stubs).toHaveLength(0);
  });

  it("signal C: flags every constant in the set", () => {
    expect(scan(`function a() { return {}; }\n`).stubs).toHaveLength(1);
    expect(scan(`function b() { return ""; }\n`).stubs).toHaveLength(1);
    expect(scan(`function c() { return false; }\n`).stubs).toHaveLength(1);
    expect(scan(`function d() { return undefined; }\n`).stubs).toHaveLength(1);
    expect(scan(`class X {\n  getUser() { return null; }\n}\n`).stubs).toHaveLength(1);
  });

  it("signal C: `true` and `0` are not in the constant set", () => {
    expect(scan(`function a() { return true; }\n`).stubs).toHaveLength(0);
    expect(scan(`function b() { return 0; }\n`).stubs).toHaveLength(0);
  });

  it("signal C: a bare expression-body arrow is out of scope (return form only)", () => {
    expect(scan(`const f = () => null;\n`).stubs).toHaveLength(0);
  });

  it("signal C: control keywords and logic before the return do not flag", () => {
    expect(scan(`if (x) { return null; }\n`).stubs).toHaveLength(0);
    expect(scan(`function f() { const x = 1; return null; }\n`).stubs).toHaveLength(0);
    expect(scan(`function find(id) { return users.find(u => u.id === id) ?? null; }\n`).stubs).toHaveLength(0);
  });

  it("signal D: empty constructors, catch blocks, and control blocks do not flag", () => {
    expect(scan(`class X {\n  constructor() {}\n}\n`).stubs).toHaveLength(0);
    expect(scan(`try { work(); } catch (e) {}\n`).stubs).toHaveLength(0);
    expect(scan(`if (x) {}\n`).stubs).toHaveLength(0);
    expect(scan(`for (;;) {}\n`).stubs).toHaveLength(0);
    expect(scan(`while (x) {}\n`).stubs).toHaveLength(0);
  });

  it("signal D: a promise `.catch(() => {})` is a deliberate error-ignore, not a stub", () => {
    expect(scan(`void db.close().catch(() => {});\n`).stubs).toHaveLength(0);
    expect(scan(`fetch(url).catch(() => {});\n`).stubs).toHaveLength(0);
  });

  it("signal D: an empty arrow nested as a call argument or collection element is a callback, not a definition", () => {
    // A never-settling `new Promise(() => {})` is a smell, but the arrow
    // is a callback argument, not an unimplemented function definition —
    // flagging it docked a minimal IndexedDB fixture's databaseLayer
    // score from 8 to 5 (detector-accuracy.test.ts). Value positions
    // still flag: assignment, object property, return.
    expect(scan(`return new Promise(() => {});\n`).stubs).toHaveLength(0);
    expect(scan(`setTimeout(() => {}, 100);\n`).stubs).toHaveLength(0);
    expect(scan(`const arr = [() => {}];\n`).stubs).toHaveLength(0);
    expect(scan(`return () => {};\n`).stubs).toHaveLength(1);
    expect(scan(`const obj = { handler: () => {} };\n`).stubs).toHaveLength(1);
    expect(scan(`const handler = () => {};\n`).stubs).toHaveLength(1);
  });

  it("signal D: object literals and exported empty functions", () => {
    expect(scan(`const x = {};\n`).stubs).toHaveLength(0);
    expect(scan(`const obj = { foo() {} };\n`).stubs).toHaveLength(1);
    expect(scan(`export function foo() {}\n`).stubs).toHaveLength(1);
  });

  it("signals B/C/D: test files and mock data files stay exempt", () => {
    expect(scan(`function foo() {}\n`, "src/foo.test.ts").stubs).toHaveLength(0);
    expect(scan(`function foo() { return null; }\n`, "src/foo.test.ts").stubs).toHaveLength(0);
    expect(scan(`const msg = "coming soon";\n`, "src/foo.test.ts").stubs).toHaveLength(0);
    expect(scan(`function foo() {}\n`, "src/mocks/data.ts").stubs).toHaveLength(0);
    expect(scan(`interface Foo { bar(): void; }\n`).stubs).toHaveLength(0);
  });
});
