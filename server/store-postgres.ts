// Postgres backend for the store (pg). Used in production on Railway when
// DATABASE_URL is set. The pool is injectable so tests can run the real
// Postgres SQL against an in-memory emulator.
import { Pool, type PoolClient } from "pg";
import type { Db, Dialect } from "./store";
import { log } from "./logger";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  credits_balance INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_transactions (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_txn_ref ON credit_transactions(ref);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_txn_user ON credit_transactions(user_id);
CREATE TABLE IF NOT EXISTS pending_credits (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  credits INTEGER NOT NULL,
  pack_id TEXT,
  stripe_event_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_credits_email ON pending_credits(email);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace_files (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  line_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, path)
);
CREATE INDEX IF NOT EXISTS idx_workspace_files_user ON workspace_files(user_id);
`;

/** Minimal pool surface; real pg.Pool and pg-mem's pool both satisfy it. */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

class PostgresDb implements Db {
  readonly dialect: Dialect = "postgres";
  private pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const res = await this.pool.query(sql, params);
    return (res.rows[0] as T | undefined) ?? undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(sql, params);
    return res.rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = await this.pool.query(sql, params);
    return { changes: res.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new PostgresTx(client);
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* noop */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async initSchema(): Promise<void> {
    // One statement per query: pg's simple-query protocol also accepts
    // multi-statement strings, but emulators (and some proxies) do not.
    for (const stmt of SCHEMA.split(";")) {
      const sql = stmt.trim();
      if (sql) await this.pool.query(sql);
    }
    log.info("Auth store ready (postgres)");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PostgresTx implements Db {
  readonly dialect: Dialect = "postgres";
  private client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const res = await this.client.query(sql, params);
    return (res.rows[0] as T | undefined) ?? undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(sql, params);
    return res.rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = await this.client.query(sql, params);
    return { changes: res.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  // Nested transactions reuse the same client (savepoints omitted; the
  // store never nests transactions).
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async initSchema(): Promise<void> {
    throw new Error("initSchema not supported inside a transaction");
  }

  async close(): Promise<void> {
    throw new Error("close not supported inside a transaction");
  }
}

export function createPostgresDb(connectionString: string, pool?: PgPoolLike): Db {
  if (pool) return new PostgresDb(pool);
  // Railway's internal database URL is plaintext on the private network;
  // anything else verifies TLS normally (never skip verification).
  const ssl = connectionString.includes("railway.internal") ? false : true;
  return new PostgresDb(
    new Pool({ connectionString, ssl, max: 5 }) as unknown as PgPoolLike
  );
}
