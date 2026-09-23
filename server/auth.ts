// Password hashing (scrypt, stdlib only) and opaque session tokens.
// Sessions are random 256-bit tokens; only the SHA-256 hash is stored.
import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { getAuthDb } from "./authdb";

export interface SessionUser {
  id: string;
  email: string;
  credits: number;
}

const SESSION_COOKIE = "codedoc_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function newSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function createPasswordHash(password: string): { hash: string; salt: string } {
  const salt = newSalt();
  return { hash: hashPassword(password, salt), salt };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createSession(userId: string): { token: string; expiresAt: Date } {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const db = getAuthDb();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(tokenHash(token), userId, new Date().toISOString(), expiresAt.toISOString());
  return { token, expiresAt };
}

export function destroySession(token: string): void {
  getAuthDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function getSessionUser(req: Request): SessionUser | null {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)codedoc_session=([^;]+)/);
  if (!match) return null;
  let token: string;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const db = getAuthDb();
  const row = db
    .prepare(
      `SELECT s.user_id AS id, s.expires_at AS expiresAt, u.email, u.credits_balance AS credits
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash(token)) as
    | { id: string; email: string; credits: number; expiresAt: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return { id: row.id, email: row.email, credits: row.credits };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${expiresAt.toUTCString()}`
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
}

export { SESSION_COOKIE };
export type { Request, Response, NextFunction };
