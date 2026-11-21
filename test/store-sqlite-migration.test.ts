// Regression test for the 2026-11-21 startup crash (Revision 3): initSchema
// must succeed on an existing database whose finalread_projects table
// predates the Rev 3 columns (no request_id, no scan_in_progress_at).
// The Rev 3 build put CREATE INDEX ... ON finalread_projects(request_id)
// in the SCHEMA, which runs before the migration that adds the column — on
// existing databases the index build threw (Postgres: ComputeIndexAttrs;
// SQLite: no such column), initStore threw, and both Railway services
// crashed at startup. Fresh databases never hit it (their CREATE TABLE
// includes the column), which is why the full suite passed.
// Note: pg-mem cannot express this scenario (it cannot re-run CREATE TABLE
// IF NOT EXISTS once the table exists), so the SQLite backend carries the
// regression coverage; the migration function is shared by both dialects.
import { describe, it, expect } from "vitest";
import { createSqliteDb } from "../server/store-sqlite";

describe("initSchema on a pre-Rev-3 database", () => {
  it("succeeds when finalread_projects lacks request_id, and the migration adds the column + index", async () => {
    const db = createSqliteDb();
    // Old shape, exactly as the seller-saving build created it (main 9ab4b5f).
    await db.exec(
      `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, credits_balance INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`
    );
    await db.exec(
      `CREATE TABLE finalread_projects (id TEXT PRIMARY KEY, seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, finalread_review_id TEXT, purchase_stripe_event_id TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
    );
    await db.exec(`CREATE INDEX idx_finalread_projects_seller ON finalread_projects(seller_user_id)`);
    await db.exec(`CREATE INDEX idx_finalread_projects_review ON finalread_projects(finalread_review_id)`);
    await expect(db.initSchema()).resolves.toBeUndefined();
    // The migration added both Rev 3 columns...
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(finalread_projects)`);
    expect(cols.map((c) => c.name)).toContain("request_id");
    expect(cols.map((c) => c.name)).toContain("scan_in_progress_at");
    // ...and the request_id index.
    const idx = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'finalread_projects' AND name = 'idx_finalread_projects_request'`
    );
    expect(idx).toHaveLength(1);
    await db.close();
  });
});
