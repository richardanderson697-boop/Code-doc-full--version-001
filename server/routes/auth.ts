// Email + password auth: signup, login, logout, me.
import { Router } from "express";
import crypto from "crypto";
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

const router = Router();

const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS ?? 50);

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

export default router;
