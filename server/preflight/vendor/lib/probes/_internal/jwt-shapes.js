// src/lib/probes/_internal/jwt-shapes.js
//
// A decoded JWT used as identity (CWE-347).
//
// `jwt.decode` reads the payload and does not check the signature. That is the
// right call for reading a non-security claim, and the wrong one for deciding
// who somebody is: the payload is base64, so anyone holding a token can edit
// `sub` or `role`, re-encode, and be believed.
//
// `jwt.verify(token)` with no key was already reported. This is the shape that
// reads as deliberate, because `decode` is what the author meant to type.
//
// Lives in its own module rather than in probes/auth.js because auth.js was
// already within 82 lines of the size at which PreFlight reports its own
// source, and a recall fix should not cost a self-finding.

// The library calls below all decode without verifying, by their own API
// contract: jsonwebtoken's `jwt.decode`, the `jwt-decode` package's default
// export (`jwtDecode` / `jwt_decode`), and jose's `decodeJwt`.
const JWT_DECODE_CALL_SRC = String.raw`(?:jwt|jsonwebtoken)\s*\.\s*decode\s*\(|\bjwt[_-]?[dD]ecode\s*\(|\bdecodeJwt\s*\(`;

// The places a value lands when it has become the request's identity. Writing
// to one of these is the step that turns a decoded payload into an
// authorization decision.
const IDENTITY_SLOT_SRC = String.raw`(?:(?:req|request|ctx|context|event|res|response|socket)\s*\.\s*(?:session\s*\.\s*)?(?:user|currentUser|authUser|auth|locals\s*\.\s*user|state\s*\.\s*user)|(?:^|[^.\w$])(?:currentUser|authUser|loggedInUser|sessionUser))`;

// Claim names that only get read to make an access decision.
const AUTHZ_CLAIM_SRC = String.raw`role|roles|permissions|perms|scope|scopes|isAdmin|is_admin|isSuperuser|isStaff|tier|plan|entitlements`;

const JWT_DECODE_IDENTITY_ASSIGN_RE = new RegExp(
  String.raw`(?:${IDENTITY_SLOT_SRC})\s*=\s*(?:await\s+)?(?:${JWT_DECODE_CALL_SRC})`,
  'g'
);
const JWT_DECODE_BINDING_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:${JWT_DECODE_CALL_SRC})`,
  'g'
);
const JWT_DECODE_DESTRUCTURE_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:${JWT_DECODE_CALL_SRC})`,
  'g'
);
const AUTHZ_CLAIM_NAME_RE = new RegExp(String.raw`\b(?:${AUTHZ_CLAIM_SRC}|sub|userId|user_id)\b`);

// A verify call that is handed something to verify against. When a file does
// this anywhere, a decode sitting next to it is usually the companion read
// (`decode` the header to pick a key, then verify), and staying quiet is worth
// more than the finding.
const JWT_VERIFY_WITH_KEY_RE = /jwt\s*\.\s*verify\s*\(\s*[^,()]+,\s*[^)]+\)/;

const escapeIdent = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Findings for decoded JWTs that are used as identity.
 *
 * File-scoped rather than per-line, because the shape usually spans two
 * statements: decode into a local, then assign that local to req.user.
 *
 * @param {{path: string, content: string}} file
 * @param {string} decodeView code-shape view (comments and string bodies
 *   blanked), so a remediation string quoting `req.user = jwt.decode(token)`
 *   cannot report itself.
 * @param {string[]} originalLines raw source lines, for evidence text.
 */
export function findDecodedJwtIdentityUses(file, decodeView, originalLines) {
  const findings = [];
  if (!/decode/i.test(decodeView) || JWT_VERIFY_WITH_KEY_RE.test(decodeView)) return findings;

  const reportedLines = new Set();
  const lineOfIndex = (idx) => decodeView.slice(0, idx).split('\n').length - 1;
  const report = (idx, use) => {
    const lineIdx = lineOfIndex(idx);
    if (reportedLines.has(lineIdx)) return;
    reportedLines.add(lineIdx);
    findings.push({
      id: `auth-decodeasidentity-${file.path}-${lineIdx}`,
      probe: 'Auth Weakness',
      title: 'Decoded JWT used as identity without verification',
      severity: 'critical',
      category: 'Auth & Access',
      cwe: 'CWE-347',
      file: file.path,
      line: lineIdx + 1,
      evidence: (originalLines[lineIdx] || '').trim().slice(0, 200),
      remediation: `jwt.decode reads the payload and never checks the signature, so ${use} trusts whatever the caller typed into the token. A JWT payload is base64, not encryption: change "role":"user" to "role":"admin", re-encode, and this code believes it. Call jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }) and use its return value instead. Keep jwt.decode only for claims you do not act on, such as logging an expiry.`,
    });
  };

  JWT_DECODE_IDENTITY_ASSIGN_RE.lastIndex = 0;
  for (const m of decodeView.matchAll(JWT_DECODE_IDENTITY_ASSIGN_RE)) {
    report(m.index, 'the identity slot it is assigned to');
  }

  JWT_DECODE_BINDING_RE.lastIndex = 0;
  for (const m of decodeView.matchAll(JWT_DECODE_BINDING_RE)) {
    const name = escapeIdent(m[1]);
    const assignedToIdentity = new RegExp(
      String.raw`(?:${IDENTITY_SLOT_SRC})\s*=\s*${name}\b`
    ).test(decodeView);
    const readAsAuthz = new RegExp(
      String.raw`\b${name}\s*(?:\?\.|\.)\s*(?:${AUTHZ_CLAIM_SRC})\b`
    ).test(decodeView);
    if (assignedToIdentity || readAsAuthz) {
      report(
        m.index,
        assignedToIdentity ? 'the identity it is assigned to' : 'the access check that reads it'
      );
    }
  }

  JWT_DECODE_DESTRUCTURE_RE.lastIndex = 0;
  for (const m of decodeView.matchAll(JWT_DECODE_DESTRUCTURE_RE)) {
    if (AUTHZ_CLAIM_NAME_RE.test(m[1])) report(m.index, 'the claim it pulls out');
  }

  return findings;
}
