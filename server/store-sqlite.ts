// SQLite backend for the store (node:sqlite, zero new dependencies).
// Used for local development and the test suite. SQL arrives with Postgres-
// style $1 placeholders and is rewritten to ? before execution.
import path from "path";
import fs from "fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Db, Dialect } from "./store";
import { dataDir } from "./db";
import { log } from "./logger";

const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS pending_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  credits INTEGER NOT NULL,
  pack_id TEXT,
  stripe_event_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_credits_email ON pending_credits(email);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_files (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  line_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, path)
);
CREATE INDEX IF NOT EXISTS idx_workspace_files_user ON workspace_files(user_id);
`;

function toSqlite(sql: string): string {
  return sql.replace(/\$(\d+)/g, "?");
}

class SqliteDb implements Db {
  readonly dialect: Dialect = "sqlite";
  private db: DatabaseSync;

  constructor() {
    const dir = dataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, "auth.db"));
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(toSqlite(sql)).get(...(params as SQLInputValue[])) as T | undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(toSqlite(sql)).all(...(params as SQLInputValue[])) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = this.db.prepare(toSqlite(sql)).run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes) || 0 };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* noop */
      }
      throw err;
    }
  }

  async initSchema(): Promise<void> {
    this.db.exec(SCHEMA);
    log.info("Auth store ready (sqlite)");
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      /* noop */
    }
  }
}

export function createSqliteDb(): Db {
  return new SqliteDb();
}
