// Backend-agnostic data store.
//
// - SQLite (node:sqlite, zero new dependencies) when DATABASE_URL is unset:
//   local development and the test suite.
// - Postgres (pg) when DATABASE_URL is set: production on Railway.
//
// SQL is written once with Postgres-style $1 placeholders; the SQLite
// backend rewrites them to ?. The two backends expose identical behavior,
// including transactions and idempotent inserts.

export type Dialect = "sqlite" | "postgres";

/** Minimal async query surface both backends implement. */
export interface Db {
  readonly dialect: Dialect;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  initSchema(): Promise<void>;
  close(): Promise<void>;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  credits_balance: number;
}

export interface PendingCreditRow {
  id: number;
  email: string;
  credits: number;
  pack_id: string | null;
  stripe_event_id: string | null;
}

import { createSqliteDb } from "./store-sqlite";
import { createPostgresDb } from "./store-postgres";

let db: Db | null = null;

export function isPostgres(): boolean {
  return !!process.env.DATABASE_URL;
}

/** Singleton store. Postgres in production, SQLite everywhere else. */
export function getDb(): Db {
  if (!db) {
    db = process.env.DATABASE_URL ? createPostgresDb(process.env.DATABASE_URL) : createSqliteDb();
  }
  return db;
}

/** Create tables/indexes if they do not exist. Safe to run on every boot. */
export async function initStore(): Promise<void> {
  await getDb().initSchema();
}

/** Test-only: drop the cached backend so a fresh DATABASE_URL / data dir takes effect. */
export function _resetDbForTests(): void {
  if (db) {
    void db.close().catch(() => {});
    db = null;
  }
}
