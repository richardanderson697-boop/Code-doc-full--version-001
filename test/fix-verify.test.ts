import { describe, it, expect } from "vitest";
import { extractAddedCode, verifySuggestedFix } from "../server/fix-verify";

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
