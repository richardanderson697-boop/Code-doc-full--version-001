// Postgres backend for the store (pg). Used in production on Railway when
// DATABASE_URL is set. The pool is injectable so tests can run the real
// Postgres SQL against an in-memory emulator.
import { Pool, type PoolClient } from "pg";
import type { Db, Dialect } from "./store";
import { log } from "./logger";
import {
  migrateFinalReadProjectColumns,
  migrateFinalReadSchemaAfter,
  migrateFinalReadSchemaBefore,
} from "./finalread-projects";

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
CREATE TABLE IF NOT EXISTS workspace_sources (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  owner TEXT,
  repo TEXT,
  url TEXT,
  filename TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Password-reset tokens: only the SHA-256 hash is stored, never the raw
-- token. Single-use (used_at) with a short expiry (expires_at).
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
-- FinalRead $199 bundle: re-scan entitlements (2 per purchase, 90-day
-- expiry, separate from the credit balance) and the minimal frozen-version
-- record (version id + content hash + buyer + purchase). See
-- server/finalread-rescans.ts.
CREATE TABLE IF NOT EXISTS finalread_rescan_entitlements (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_event_id TEXT UNIQUE NOT NULL,
  pack_id TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rescan_entitlements_user ON finalread_rescan_entitlements(user_id);
CREATE TABLE IF NOT EXISTS finalread_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purchase_stripe_event_id TEXT,
  content_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_reviews_seller ON finalread_reviews(seller_user_id);
CREATE INDEX IF NOT EXISTS idx_finalread_reviews_project ON finalread_reviews(project_id);
CREATE TABLE IF NOT EXISTS finalread_review_versions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES finalread_reviews(id) ON DELETE CASCADE,
  project_id TEXT,
  version_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  audit_snapshot_id TEXT,
  stripe_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_versions_review ON finalread_review_versions(review_id);
CREATE TABLE IF NOT EXISTS finalread_projects (
  id TEXT PRIMARY KEY,
  seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  finalread_review_id TEXT,
  purchase_stripe_event_id TEXT,
  request_id TEXT,
  scan_in_progress_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_projects_seller ON finalread_projects(seller_user_id);
CREATE INDEX IF NOT EXISTS idx_finalread_projects_review ON finalread_projects(finalread_review_id);
CREATE INDEX IF NOT EXISTS idx_finalread_projects_request ON finalread_projects(request_id);
-- FinalRead buyer-initiated review requests (two-sided flow spec Rev 3,
-- §4a): the buyer creates the request and its 8-character code, which the
-- seller binds a project to at save time. One code flows
-- buyer -> seller -> buyer (one-code decision, CONFIRMED 2026-11-21).
-- status: requested (unbound) -> uploaded (bound to a project) ->
-- reserved (buyer in checkout) -> activated (paid) / expired / revoked.
CREATE TABLE IF NOT EXISTS finalread_review_requests (
  id TEXT PRIMARY KEY,
  buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'requested',
  project_id TEXT,
  reserved_by TEXT,
  reserved_until TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_requests_buyer ON finalread_review_requests(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_finalread_requests_project ON finalread_review_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_finalread_requests_code_hash ON finalread_review_requests(code_hash);
CREATE TABLE IF NOT EXISTS finalread_audit_snapshots (
  id TEXT PRIMARY KEY,
  version_id TEXT,
  review_id TEXT NOT NULL REFERENCES finalread_reviews(id) ON DELETE CASCADE,
  audit JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_snapshots_review ON finalread_audit_snapshots(review_id);
CREATE TABLE IF NOT EXISTS finalread_reports (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES finalread_review_versions(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL REFERENCES finalread_reviews(id) ON DELETE CASCADE,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_reports_review ON finalread_reports(review_id);
CREATE TABLE IF NOT EXISTS finalread_buyer_access (
  id TEXT PRIMARY KEY,
  buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  review_id TEXT NOT NULL REFERENCES finalread_reviews(id) ON DELETE CASCADE,
  invite_code_id TEXT NOT NULL,
  stripe_event_id TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_buyer_access_buyer ON finalread_buyer_access(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_finalread_buyer_access_review ON finalread_buyer_access(review_id);
CREATE TABLE IF NOT EXISTS finalread_invite_codes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'issued',
  reserved_by TEXT,
  reserved_until TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  buyer_user_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_invite_codes_project ON finalread_invite_codes(project_id);
CREATE TABLE IF NOT EXISTS finalread_qa_history (
  id SERIAL PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES finalread_review_versions(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL REFERENCES finalread_reviews(id) ON DELETE CASCADE,
  buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  cited_findings JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_qa_version ON finalread_qa_history(version_id);
CREATE TABLE IF NOT EXISTS finalread_refund_records (
  id SERIAL PRIMARY KEY,
  stripe_event_id TEXT NOT NULL,
  invite_code_id TEXT,
  project_id TEXT,
  buyer_user_id TEXT NOT NULL,
  payment_intent TEXT,
  refund_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_refunds_event ON finalread_refund_records(stripe_event_id);
CREATE TABLE IF NOT EXISTS finalread_pending_activations (
  id SERIAL PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  invite_code_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,
  payment_intent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS finalread_report_jobs (
  id SERIAL PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES finalread_reviews(id) ON DELETE CASCADE,
  stripe_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finalread_report_jobs_review ON finalread_report_jobs(review_id);
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
    // The legacy frozen-version table (finalread_review_versions, old
    // shape) is repurposed into finalread_reviews BEFORE the SCHEMA runs,
    // so the SCHEMA's CREATE TABLE IF NOT EXISTS finalread_review_versions
    // creates the NEW versions table instead of skipping on the old one.
    await migrateFinalReadSchemaBefore(this);
    // One statement per query: pg's simple-query protocol also accepts
    // multi-statement strings, but emulators (and some proxies) do not.
    for (const stmt of SCHEMA.split(";")) {
      const sql = stmt.trim();
      if (sql) await this.pool.query(sql);
    }
    // Version-1 rows for the migrated reviews (idempotent).
    await migrateFinalReadSchemaAfter(this);
    // Rev 3 project columns (request_id, scan_in_progress_at) for
    // databases created before this build.
    await migrateFinalReadProjectColumns(this);
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
