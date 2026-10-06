// server/fix-verify.ts
//
// Deterministic post-check on AI-suggested fixes. Prompt instructions are not
// enough — we saw a fix that added requireAuth while still trusting
// req.body userId. This runs targeted checks on the ADDED code (the AFTER
// side of the diff) and flags fixes that don't actually fix the finding.
// The suggestion is still returned (review-only); the issues are surfaced
// alongside it so the reviewer knows what to look for.

export interface FixVerification {
  passed: boolean;
  issues: string[];
}

// Returns true if the input contains actual code (not just comments and
// whitespace). The healer must refuse comment-only input: the ZIP-upload flow
// sets the editor to a status message ("Custom ZIP Codebase Loaded
// Successfully!..."), and the model reads that as a prompt to generate a
// codebase-auditor UI instead of healing.
export function hasActualCode(inputCode: string): boolean {
  let s = String(inputCode || "");
  // Strip block comments, then line comments, then string literals are kept
  // (a string literal alone isn't healable code either, but that's rare).
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return s.trim().length > 0;
}

// Verifies healed code actually heals the input instead of hallucinating a
// new app. The healer once returned a branded demo app ("VibeCoder Codebase
// Auditor") instead of the user's truncated code — the prompt identity leaked.
// A genuine healing = the input (minus the truncated tail) appearing as a
// contiguous block in the output, plus the input's distinctive identifiers.
// Scattered generic lines (like `import React from 'react';`) don't count.
export function verifyHealedCode(inputCode: string, healedCode: string): { passed: boolean; reason?: string } {
  const input = String(inputCode || "").trim();
  const healed = String(healedCode || "").trim();
  if (!input) return { passed: true };
  if (!healed) return { passed: false, reason: "The heal returned empty output. No credits were charged." };

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  // Primary check: the stable part of the input (dropping the last 2 lines,
  // which may be cut mid-truncation) must appear verbatim in the output.
  const inputLines = input.split("\n");
  const stableLines = inputLines.slice(0, Math.max(1, inputLines.length - 2));
  const stableBlock = norm(stableLines.join("\n"));
  if (stableBlock.length > 40 && norm(healed).includes(stableBlock)) {
    return { passed: true };
  }

  // Fallback: distinctive identifiers (6+ chars, not keywords) from the input
  // must mostly appear in the output. Generic imports don't count.
  const stopwords = new Set([
    "import", "export", "return", "const", "function", "default", "React",
    "useState", "useEffect", "useMemo", "from", "require",
  ]);
  const identifiers = [...new Set(input.match(/\b[A-Za-z_][A-Za-z0-9_]{5,}\b/g) || [])].filter(
    (w) => !stopwords.has(w)
  );
  if (identifiers.length === 0) return { passed: true };
  const hits = identifiers.filter((id) => healed.includes(id)).length;
  if (hits / identifiers.length < 0.5) {
    return {
      passed: false,
      reason: `The healed output doesn't contain the submitted code (${hits}/${identifiers.length} distinctive identifiers found) — the model generated new code instead of healing. No credits were charged.`,
    };
  }
  return { passed: true };
}

// Pull the added code out of a unified diff (+ lines) or a BEFORE/AFTER
// block pair (text after the AFTER: marker).
export function extractAddedCode(remediationDiff: string): string {
  const lines = String(remediationDiff || "").split("\n");
  const added: string[] = [];
  let inAfter = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^AFTER:/i.test(t)) {
      inAfter = true;
      continue;
    }
    if (/^BEFORE:/i.test(t) || /^HOW TO VERIFY/i.test(t)) {
      inAfter = false;
      continue;
    }
    if (inAfter) added.push(line);
    else if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
  }
  return added.join("\n");
}

export function verifySuggestedFix(
  remediationDiff: string,
  finding: { probe?: string; title?: string }
): FixVerification {
  const issues: string[] = [];
  const added = extractAddedCode(remediationDiff);
  if (!added.trim()) return { passed: true, issues };

  const probe = finding.probe || "";
  const isAuthFinding = /API Route Auth|Demo Bypass|Auth Weakness|Admin Route/i.test(probe);

  if (isAuthFinding) {
    // 1. The fix must not keep reading identity from the request.
    // (Allowed when the body userId is compared against the verified token
    // user — the verify-checkout pattern of matching session metadata.)
    const trustsBodyUserId =
      /const\s*\{\s*[^}]*\buserId\b[^}]*\}\s*=\s*req\.(body|query)/i.test(added) ||
      /req\.(body|query)\.userId/i.test(added);
    const comparesAgainstToken = /authUser|verifiedUser|tokenUser|getUser/i.test(added);
    if (trustsBodyUserId && !comparesAgainstToken) {
      issues.push(
        "The suggested fix still reads userId from the request body/query. Identity must come from the verified token or session, not client input."
      );
    }
    // 2. The fix must show identity verification.
    const verifiesIdentity =
      /getUser\s*\(|Authorization|verifyToken|getServerSession|requireAuth|authenticate\s*\(/i.test(
        added
      );
    if (!verifiesIdentity) {
      issues.push(
        "The suggested fix does not show how the caller's identity is verified (no token check, auth middleware, or session lookup in the added code)."
      );
    }
  }

  if (/Demo Bypass/i.test(probe)) {
    // 3. The demo flag must not still gate before authentication.
    const parts = added.split(/\bif\s*\(\s*!?\s*(isDemo|demoMode|testMode|skipAuth|bypassAuth)\b/i);
    if (parts.length > 1) {
      const beforeGate = parts[0];
      const authBeforeGate = /getUser\s*\(|Authorization|requireAuth|verifyToken|getServerSession/i.test(
        beforeGate
      );
      if (!authBeforeGate) {
        issues.push(
          "The suggested fix keeps the demo flag gate before authentication. Move the flag check behind the auth check, or rate-limit the route."
        );
      }
    }
  }

  return { passed: issues.length === 0, issues };
}
