// Option (b): a route whose handler is delegated out of the file cannot have
// its auth established by the per-file probe. It must report "could not
// verify" at low — not assert "without auth check" at CRITICAL. Real misses
// (inline or in-file handlers with no auth) must stay CRITICAL.
import { describe, it, expect } from "vitest";
import { probeAPIRouteAuth } from "../server/preflight/vendor/lib/probes/auth.js";

// Mirrors the real billing webhook: route registered in one file, HMAC
// verification in another. The probe cannot see the check from here.
const DELEGATED_WEBHOOK = `
import { handleStripeWebhook } from './billing';
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), (req, res) => {
  handleStripeWebhook(req, res).catch((err) => {
    res.status(500).json({ error: "Webhook failed" });
  });
});`;

const INLINE_NOAUTH = `
app.post("/api/admin/reset", (req, res) => {
  db.run("DELETE FROM users");
  res.json({ ok: true });
});`;

const INFILE_HANDLER_NOAUTH = `
app.post("/api/admin/purge", purgeHandler);
function purgeHandler(req, res) {
  db.run("DELETE FROM sessions");
  res.json({ ok: true });
}`;

const BARE_IMPORTED_HANDLER = `
const { hook } = require('./handlers');
app.post("/api/billing/hook", hook);`;

function run(content) {
  return probeAPIRouteAuth([{ path: "server.ts", content }]);
}

describe("probeAPIRouteAuth — delegated handlers", () => {
  it("downgrades a delegated webhook route to low 'could not verify'", () => {
    const findings = run(DELEGATED_WEBHOOK);
    expect(findings.length).toBe(1);
    const [f] = findings;
    expect(f.severity).toBe("low");
    expect(f.title).toContain("could not be verified");
    expect(f.title).not.toContain("without auth check");
  });

  it("downgrades a bare imported handler to low 'could not verify'", () => {
    const findings = run(BARE_IMPORTED_HANDLER);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("low");
    expect(findings[0].title).toContain("could not be verified");
  });

  it("keeps CRITICAL for an inline unauthenticated handler", () => {
    const findings = run(INLINE_NOAUTH);
    expect(findings.length).toBe(1);
    const [f] = findings;
    expect(f.severity).toBe("critical");
    expect(f.title).toContain("without auth check");
  });

  it("keeps CRITICAL for an in-file-defined handler without auth", () => {
    const findings = run(INFILE_HANDLER_NOAUTH);
    expect(findings.length).toBe(1);
    const [f] = findings;
    expect(f.severity).toBe("critical");
    expect(f.title).toContain("without auth check");
  });
});

describe("probeAPIRouteAuth — per-route token authentication (rung 1a)", () => {
  // Mirrors the real forgot-password handler: no session signal, but the
  // route verifies a caller token (read + token-keyed lookup + rejection
  // before the password change). All three parts, in order.
  const TOKEN_AUTH_INLINE = `
app.post("/api/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  const row = await db.get(
    "SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1",
    [hashToken(token)]
  );
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }
  await db.run("UPDATE users SET password_hash = $1 WHERE id = $2", [hash(newPassword), row.user_id]);
  res.json({ ok: true });
});`;

  const TOKEN_AUTH_INFILE = `
app.post("/api/auth/reset-password", resetPasswordHandler);
async function resetPasswordHandler(req, res) {
  const { token, newPassword } = req.body;
  const row = await db.get(
    "SELECT id FROM password_reset_tokens WHERE token_hash = $1",
    [hashToken(token)]
  );
  if (!row) {
    return res.status(400).json({ error: "Invalid token" });
  }
  await db.run("UPDATE users SET password_hash = $1", [hash(newPassword)]);
  res.json({ ok: true });
}`;

  // Token read but never validated: still a hole.
  const TOKEN_READ_WITHOUT_VALIDATION = `
app.post("/api/auth/reset-password", async (req, res) => {
  const { token } = req.body;
  await db.run("UPDATE users SET password_hash = $1 WHERE id = $2", [hash(req.body.newPassword)]);
  res.json({ ok: true });
});`;

  // Lookup by user id alone is not a token lookup.
  const USER_ID_ONLY_LOOKUP = `
app.post("/api/auth/reset-password", async (req, res) => {
  const { token } = req.body;
  const user = await db.get("SELECT id FROM users WHERE id = $1", [req.body.userId]);
  if (!user) {
    return res.status(400).json({ error: "No such user" });
  }
  await db.run("UPDATE users SET password_hash = $1 WHERE id = $2", [hash(req.body.newPassword), user.id]);
  res.json({ ok: true });
});`;

  // Token validated only AFTER the password change: still a hole.
  const MUTATION_BEFORE_REJECTION = `
app.post("/api/auth/reset-password", async (req, res) => {
  const { token } = req.body;
  const row = await db.get(
    "SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1",
    [hashToken(token)]
  );
  await db.run("UPDATE users SET password_hash = $1 WHERE id = $2", [hash(req.body.newPassword), row.user_id]);
  if (!row || row.used_at) {
    return res.status(400).json({ error: "Invalid token" });
  }
  res.json({ ok: true });
});`;

  it("skips an inline handler that verifies a caller token", () => {
    expect(run(TOKEN_AUTH_INLINE)).toEqual([]);
  });

  it("skips an in-file handler that verifies a caller token", () => {
    expect(run(TOKEN_AUTH_INFILE)).toEqual([]);
  });

  it("keeps CRITICAL when the token is read but never validated", () => {
    const findings = run(TOKEN_READ_WITHOUT_VALIDATION);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].title).toContain("without auth check");
  });

  it("keeps CRITICAL when the lookup is by user id, not by token", () => {
    const findings = run(USER_ID_ONLY_LOOKUP);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].title).toContain("without auth check");
  });

  it("keeps CRITICAL when the mutation precedes the rejection", () => {
    const findings = run(MUTATION_BEFORE_REJECTION);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].title).toContain("without auth check");
  });

  it("does not let one token-auth route exempt another route in the file", () => {
    const findings = run(`${TOKEN_AUTH_INLINE}\n${INLINE_NOAUTH}`);
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain("/api/admin/reset");
    expect(findings[0].severity).toBe("critical");
  });

  it("marks delegated findings unverified, and established findings not", () => {
    const [delegated] = run(DELEGATED_WEBHOOK);
    expect(delegated.unverified).toBe(true);
    const [inline] = run(INLINE_NOAUTH);
    expect(inline.unverified).toBeUndefined();
  });
});
