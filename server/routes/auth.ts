// Email + password auth: signup, login, logout, me.
import { Router } from "express";
import crypto from "crypto";
import { BlockList, isIP } from "node:net";
import { getDb, type UserRow } from "../store";
import {
  createPasswordHash,
  verifyPassword,
  normalizeEmail,
  validEmail,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionUser,
} from "../auth";
import { asyncRoute } from "../async-route";
import { claimPendingCredits } from "../credits";
import { log } from "../logger";
import { sendPasswordResetEmail, emailConfigured } from "../email";

const router = Router();

const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS ?? 50);
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Tiny in-memory throttle for the auth endpoints (finalread-self-scan-
// fixes-spec.md Part B): max 5 signup requests per email per hour and 10
// per IP, 10 logins per email per hour and 30 per IP, 30 password resets
// per IP per hour; forgot-password keeps 5 per email and 30 per IP.
// Prevents credential stuffing and email bombing via the endpoints.
// Resets on restart, which is fine for abuse throttling.
const authAttempts = new Map<string, number[]>();
function throttleOk(key: string, limit: number): boolean {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const times = (authAttempts.get(key) ?? []).filter((t) => t > windowStart);
  if (times.length >= limit) return false;
  times.push(now);
  authAttempts.set(key, times);
  return true;
}

/** Test-only: clear the in-memory auth throttle map so each test starts
 * fresh. The suite creates dozens of users from one IP, which would trip
 * the per-IP limits across tests; the global setup calls this before each
 * test. Production never calls it. */
export function _resetAuthThrottlesForTests(): void {
  authAttempts.clear();
}

// Client IP for the throttle keys (finalread-cf-connecting-ip-spec.md).
// Trusts CF-Connecting-IP only when the LAST X-Forwarded-For value —
// the one appended by Railway, which the caller cannot forge — falls
// inside Cloudflare's published IP ranges. That proves the request
// came through a Cloudflare edge (gradevibes.com); on the direct
// Railway path (getfinalread.com) the last value is the visitor's own
// IP, so a faked CF-Connecting-IP is ignored there. The req.ip fallback
// covers direct (non-proxied) requests. Do not "fix" this by trusting
// req.ip alone: behind Railway the socket peer is Railway's proxy, so
// that would put every user in one bucket. Exported for the unit test.

// Cloudflare's published ranges, fetched 2026-11-23 from
// https://www.cloudflare.com/ips-v4 and /ips-v6. Static; refresh
// if Cloudflare publishes new ranges (see the staleness note in the spec).
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22",
  "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22",
  "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32",
  "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29",
  "2c0f:f248::/32",
];
const cloudflareRanges = new BlockList();
for (const cidr of CLOUDFLARE_V4) {
  const [net, prefix] = cidr.split("/");
  cloudflareRanges.addSubnet(net, Number(prefix), "ipv4");
}
for (const cidr of CLOUDFLARE_V6) {
  const [net, prefix] = cidr.split("/");
  cloudflareRanges.addSubnet(net, Number(prefix), "ipv6");
}

function isCloudflareIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return cloudflareRanges.check(ip, family === 4 ? "ipv4" : "ipv6");
}

// Rate-limited observability for the stale-range failure (see the spec):
// CF-Connecting-IP present but the last XFF value not in Cloudflare's
// ranges. Fires on spoof attempts too, so at most once an hour.
let lastCfRangeMismatchLogAt = 0;
function logCfRangeMismatch(): void {
  const now = Date.now();
  if (now - lastCfRangeMismatchLogAt < 60 * 60 * 1000) return;
  lastCfRangeMismatchLogAt = now;
  log.warn("CF-Connecting-IP present but last XFF not in Cloudflare ranges");
}

export function clientIp(req: any): string {
  const forwarded = req.headers["x-forwarded-for"] as string | undefined;
  let last: string | undefined;
  if (forwarded) {
    const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) last = parts[parts.length - 1];
  }
  // Behind Cloudflare (gradevibes.com), the real client IP is in
  // CF-Connecting-IP. Cloudflare sets it and overwrites any
  // client-supplied value — but only trust it when the last XFF
  // value proves the request came through Cloudflare. The last
  // value is appended by Railway, so the caller cannot forge it.
  // Validate it is a real IP first, so junk never becomes a
  // throttle key.
  const cfIp = (req.headers["cf-connecting-ip"] as string | undefined)?.trim();
  if (cfIp && isIP(cfIp) !== 0 && last && isCloudflareIp(last)) return cfIp;
  if (cfIp && last && !isCloudflareIp(last)) logCfRangeMismatch();
  // Direct to Railway (getfinalread.com): the last XFF value is
  // Railway's append of the real client IP. A faked CF-Connecting-IP
  // is ignored here, because the last value is the visitor's own IP,
  // which is not in Cloudflare's ranges.
  if (last) return last;
  return req.ip || "unknown";
}

function appBaseUrl(req: any): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() ||
    req.protocol ||
    "https";
  return `${proto}://${req.headers.host}`;
}

function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

router.post("/api/auth/signup", asyncRoute(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  const cleanEmail = normalizeEmail(String(email));
  if (!validEmail(cleanEmail)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const ip = clientIp(req);
  if (!throttleOk(`signup-email:${cleanEmail}`, 5) || !throttleOk(`signup-ip:${ip}`, 10)) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  const db = getDb();
  const existing = await db.get("SELECT id FROM users WHERE email = $1", [cleanEmail]);
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists. Try signing in." });
  }

  const { hash, salt } = createPasswordHash(String(password));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO users (id, email, password_hash, password_salt, credits_balance, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, cleanEmail, hash, salt, WELCOME_CREDITS, now]
  );
  if (WELCOME_CREDITS > 0) {
    await db.run(
      "INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES ($1, $2, $3, $4, $5)",
      [id, WELCOME_CREDITS, "welcome bonus", `welcome:${id}`, now]
    );
  }

  const { token, expiresAt } = await createSession(id);
  setSessionCookie(res, token, expiresAt);
  // Credits parked by the Stripe webhook for this email (e.g. the database
  // was replaced between checkout and delivery) are claimed onto the new
  // account, so a completed purchase is never lost.
  const claimed = await claimPendingCredits(id, cleanEmail);
  log.info(`New signup: ${cleanEmail}${claimed ? ` (claimed ${claimed} pending credits)` : ""}`);
  res.status(201).json({ user: { id, email: cleanEmail, credits: WELCOME_CREDITS + claimed } });
}));

router.post("/api/auth/login", asyncRoute(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  const cleanEmail = normalizeEmail(String(email));
  const ip = clientIp(req);
  if (!throttleOk(`login-email:${cleanEmail}`, 10) || !throttleOk(`login-ip:${ip}`, 30)) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }
  const db = getDb();
  const row = await db.get<UserRow>(
    "SELECT id, email, password_hash, password_salt, credits_balance FROM users WHERE email = $1",
    [cleanEmail]
  );
  if (!row || !verifyPassword(String(password), row.password_salt, row.password_hash)) {
    // Same response either way: no user enumeration.
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  const { token, expiresAt } = await createSession(row.id);
  setSessionCookie(res, token, expiresAt);
  // Same safety net as signup: parked webhook credits for this email land on
  // the account at login.
  const claimed = await claimPendingCredits(row.id, row.email);
  res.json({ user: { id: row.id, email: row.email, credits: row.credits_balance + claimed } });
}));

router.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)codedoc_session=([^;]+)/);
  if (match) {
    try { await destroySession(decodeURIComponent(match[1])); } catch { /* noop */ }
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}));

router.get("/api/auth/me", asyncRoute(async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in", code: "AUTH_REQUIRED" });
  res.json({ user });
}));

// Request a password-reset email. Always returns { ok: true } — even for
// unknown emails or when email isn't configured — so the endpoint can't be
// used to enumerate accounts.
router.post("/api/auth/forgot-password", asyncRoute(async (req, res) => {
  const { email } = req.body ?? {};
  const cleanEmail = normalizeEmail(String(email ?? ""));
  if (!validEmail(cleanEmail)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  const ip = clientIp(req);
  if (!throttleOk(`email:${cleanEmail}`, 5) || !throttleOk(`ip:${ip}`, 30)) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  const db = getDb();
  const row = await db.get<{ id: string }>("SELECT id FROM users WHERE email = $1", [cleanEmail]);
  if (row && emailConfigured()) {
    // Invalidate older unused tokens so only the latest link works.
    await db.run("DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL", [row.id]);
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(token);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await db.run(
      "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)",
      [id, row.id, tokenHash, expiresAt, new Date().toISOString()]
    );
    const resetUrl = `${appBaseUrl(req)}/#reset-password?token=${token}`;
    try {
      await sendPasswordResetEmail(cleanEmail, resetUrl);
      log.info(`Password reset email sent to ${cleanEmail}`);
    } catch (err: any) {
      // The token exists; the email failed. Don't leak that — the user gets
      // the same response, and the admin sees the error in the logs.
      log.error(`Failed to send password reset email to ${cleanEmail}: ${err?.message}`);
    }
  } else if (row && !emailConfigured()) {
    log.warn(`Password reset requested for ${cleanEmail} but RESEND_API_KEY is not set — no email sent`);
  }
  res.json({ ok: true });
}));

// Consume a reset token and set a new password. One generic error for every
// failure mode (unknown/expired/used token) — no enumeration.
router.post("/api/auth/reset-password", asyncRoute(async (req, res) => {
  const { token, password } = req.body ?? {};
  if (!token || !password) {
    return res.status(400).json({ error: "Reset token and new password are required." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const ip = clientIp(req);
  if (!throttleOk(`reset-ip:${ip}`, 30)) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }
  const tokenHash = hashResetToken(String(token));
  const db = getDb();
  const row = await db.get<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
    "SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1",
    [tokenHash]
  );
  const invalid =
    !row || row.used_at || new Date(row.expires_at).getTime() < Date.now();
  if (invalid) {
    return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
  }

  const { hash, salt } = createPasswordHash(String(password));
  await db.run("UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3", [hash, salt, row.user_id]);
  await db.run("UPDATE password_reset_tokens SET used_at = $1 WHERE id = $2", [new Date().toISOString(), row.id]);
  // Force re-login everywhere: a reset implies the old credentials may be
  // compromised, so no existing session survives it.
  await db.run("DELETE FROM sessions WHERE user_id = $1", [row.user_id]);
  log.info(`Password reset completed for user ${row.user_id}`);
  res.json({ ok: true });
}));

export default router;
