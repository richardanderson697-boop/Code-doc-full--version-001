// Email + password auth: signup, login, logout, me.
import { Router } from "express";
import crypto from "crypto";
import { getAuthDb } from "../authdb";
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

  const db = getAuthDb();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(cleanEmail);
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists. Try signing in." });
  }

  const { hash, salt } = createPasswordHash(String(password));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO users (id, email, password_hash, password_salt, credits_balance, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, cleanEmail, hash, salt, WELCOME_CREDITS, now);
  if (WELCOME_CREDITS > 0) {
    db.prepare(
      "INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, WELCOME_CREDITS, "welcome bonus", `welcome:${id}`, now);
  }

  const { token, expiresAt } = createSession(id);
  setSessionCookie(res, token, expiresAt);
  log.info(`New signup: ${cleanEmail}`);
  res.status(201).json({ user: { id, email: cleanEmail, credits: WELCOME_CREDITS } });
}));

router.post("/api/auth/login", asyncRoute(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  const cleanEmail = normalizeEmail(String(email));
  const db = getAuthDb();
  const row = db.prepare("SELECT id, email, password_hash, password_salt, credits_balance FROM users WHERE email = ?")
    .get(cleanEmail) as
    | { id: string; email: string; password_hash: string; password_salt: string; credits_balance: number }
    | undefined;
  if (!row || !verifyPassword(String(password), row.password_salt, row.password_hash)) {
    // Same response either way: no user enumeration.
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  const { token, expiresAt } = createSession(row.id);
  setSessionCookie(res, token, expiresAt);
  res.json({ user: { id: row.id, email: row.email, credits: row.credits_balance } });
}));

router.post("/api/auth/logout", (req, res) => {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)codedoc_session=([^;]+)/);
  if (match) {
    try { destroySession(decodeURIComponent(match[1])); } catch { /* noop */ }
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/api/auth/me", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in", code: "AUTH_REQUIRED" });
  res.json({ user });
});

export default router;
