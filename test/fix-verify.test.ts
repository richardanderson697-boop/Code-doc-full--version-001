import { describe, it, expect } from "vitest";
import { extractAddedCode, verifySuggestedFix, verifyHealedCode, hasActualCode } from "../server/fix-verify";

describe("hasActualCode", () => {
  it("rejects the ZIP-upload status message (comment-only)", () => {
    const placeholder = `// Custom ZIP Codebase Loaded Successfully!\n//\n// Extracted 64 file(s) from your archive.\n// Click the "Scan Uploaded Codebase" button on the right to map and evaluate completeness.`;
    expect(hasActualCode(placeholder)).toBe(false);
  });

  it("rejects block-comment-only input", () => {
    expect(hasActualCode(`/* just a note */\n/* another */`)).toBe(false);
  });

  it("accepts real code", () => {
    expect(hasActualCode(`import React from 'react';\n// a comment\nexport default function App() { return null; }`)).toBe(true);
  });

  it("rejects empty/whitespace", () => {
    expect(hasActualCode("   \n  ")).toBe(false);
  });
});

describe("extractAddedCode", () => {
  it("pulls + lines from a unified diff", () => {
    const diff = `--- a\n+++ b\n@@\n-const { userId } = req.body;\n+const user = await getUser(token);\n+const userId = user.id;`;
    const added = extractAddedCode(diff);
    expect(added).toMatch(/const userId = user.id/);
    expect(added).not.toMatch(/req.body/);
  });

  it("pulls the AFTER block from a BEFORE/AFTER pair", () => {
    const diff = `BEFORE:\nconst { userId } = req.body;\nAFTER:\nconst user = await getUser(token);`;
    expect(extractAddedCode(diff)).toMatch(/getUser/);
  });
});

describe("verifySuggestedFix", () => {
  const GOOD_FIX = `AFTER:\napp.post('/api/generate', async (req, res) => {\n  const { inputText, isDemo } = req.body;\n  const token = req.headers.authorization?.split(' ')[1];\n  const { data: { user: authUser } } = await admin.auth.getUser(token);\n  if (!authUser) return res.status(401).json({});\n  const userId = authUser.id;\n});`;

  const BAD_FIX = `AFTER:\napp.post('/api/create-checkout-session', requireAuth, async (req, res) => {\n  const { packId, userId, email } = req.body;\n  if (!userId) return res.status(400).json({});\n});`;

  it("passes the correct Supabase fix (token-derived identity)", () => {
    const v = verifySuggestedFix(GOOD_FIX, { probe: "API Route Auth", title: "POST /api/generate without auth check" });
    expect(v.passed).toBe(true);
    expect(v.issues).toHaveLength(0);
  });

  it("flags a fix that adds requireAuth but still trusts body userId", () => {
    const v = verifySuggestedFix(BAD_FIX, { probe: "API Route Auth", title: "POST /api/create-checkout-session without auth check" });
    expect(v.passed).toBe(false);
    expect(v.issues.join(" ")).toMatch(/still reads userId from the request body/);
  });

  it("flags a demo-bypass fix that keeps isDemo before auth", () => {
    const diff = `AFTER:\napp.post('/api/generate', async (req, res) => {\n  const { isDemo } = req.body;\n  if (isDemo) { const r = await gemini.generate('x'); return res.json(r); }\n  const token = req.headers.authorization;\n});`;
    const v = verifySuggestedFix(diff, { probe: "Demo Bypass", title: "isDemo bypass" });
    expect(v.passed).toBe(false);
    expect(v.issues.join(" ")).toMatch(/demo flag gate before authentication/);
  });

  it("ignores non-auth findings", () => {
    const v = verifySuggestedFix(BAD_FIX, { probe: "Secret Scanner", title: "hardcoded key" });
    expect(v.passed).toBe(true);
  });
});

describe("verifyHealedCode", () => {
  it("passes when the healed output preserves the input", () => {
    const input = `import React from 'react';\nconst x = 1;\nfunction App() {\n  return <div>{x}</div>;\n`;
    const healed = input + `}\nexport default App;\n`;
    expect(verifyHealedCode(input, healed).passed).toBe(true);
  });

  it("rejects a hallucinated demo app that ignores the input", () => {
    const input = `import React from 'react';\nfunction MyWidget() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>{count}</button>;\n`;
    const hallucinated = `// Custom ZIP Codebase Loaded Successfully!\nimport React, { useState, useMemo, useEffect } from 'react';\nconst generateMockCodebase = () => { return []; };\nexport default function App() {\n  const [files, setFiles] = useState(() => generateMockCodebase());\n  return <div>Auditor</div>;\n}`;
    const v = verifyHealedCode(input, hallucinated);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/doesn't contain the submitted code/);
  });

  it("rejects a mockup that shares only generic import lines with the input", () => {
    // Regression: the first version sampled generic lines like
    // `import React from 'react';` which appear in any React output,
    // so mockups slipped through. Distinctive identifiers must match.
    const input = `import React from 'react';\nfunction Dashboard() {\n  const [metrics, setMetrics] = useState(null);\n  return <div>{metrics}</div>;\n`;
    const mockup = `import React from 'react';\nconst MOCK_FILES = [];\nexport default function App() { return <div>Mock</div>; }`;
    expect(verifyHealedCode(input, mockup).passed).toBe(false);
  });
});
