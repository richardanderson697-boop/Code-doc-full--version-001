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
