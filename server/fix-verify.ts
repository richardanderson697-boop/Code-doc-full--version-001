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

// Verifies healed code actually heals the input instead of hallucinating a
// new app. The healer once returned a branded demo app ("VibeCoder Codebase
// Auditor") instead of the user's truncated code — the prompt identity leaked.
// This samples lines from the input and requires most of them to appear in
// the output; a genuine healing preserves the input, a hallucination doesn't.
export function verifyHealedCode(inputCode: string, healedCode: string): { passed: boolean; reason?: string } {
  const inputLines = String(inputCode || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 12);
  if (inputLines.length === 0) return { passed: true };
  const sample: string[] = [];
  const step = Math.max(1, Math.floor(inputLines.length / 10));
  for (let i = 0; i < inputLines.length && sample.length < 10; i += step) {
    sample.push(inputLines[i]);
  }
  const hits = sample.filter((line) => healedCode.includes(line)).length;
  if (hits / sample.length < 0.5) {
    return {
      passed: false,
      reason: `The healed output doesn't contain the submitted code (${hits}/${sample.length} sampled lines found) — the model generated new code instead of healing. No credits were charged.`,
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
