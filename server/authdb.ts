// Auth + billing persistence. SQLite via node:sqlite (zero new dependencies).
// Lives next to the existing JSON project store; the DB file honors
// CODEDOC_DATA_DIR so tests can point at a disposable directory.
import path from "path";
import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import { log } from "./logger";
import { dataDir } from "./db";

let db: DatabaseSync | null = null;

function dbPath(): string {
  return path.join(dataDir(), "auth.db");
}

export function getAuthDb(): DatabaseSync {
  if (db) return db;
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(dbPath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      credits_balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_txn_ref ON credit_transactions(ref);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_txn_user ON credit_transactions(user_id);
  `);
  return db;
}

// Test-only: drop the cached handle so a fresh CODEDOC_DATA_DIR takes effect.
export function _resetAuthDbForTests(): void {
  if (db) {
    try { db.close(); } catch { /* noop */ }
    db = null;
  }
}

export function initAuthStore(): void {
  try {
    getAuthDb();
    log.info("Auth store ready");
  } catch (err) {
    log.error("Failed to initialize auth store:", err);
    throw err;
  }
}
