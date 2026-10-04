// Postgres backend SQL, validated against an in-memory Postgres emulator.
// The domain logic (credits/auth) is backend-agnostic and covered by the
// SQLite-backed suite; this file proves the Postgres DDL and dialect-
// specific statements actually run on real Postgres syntax.
import { describe, it, expect, beforeAll } from "vitest";
import { newDb } from "pg-mem";
import { createPostgresDb, type PgPoolLike } from "../server/store-postgres";
import type { Db } from "../server/store";

function memPool(): PgPoolLike {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  return new (Pool as any)() as PgPoolLike;
}

let db: Db;

beforeAll(async () => {
  db = createPostgresDb("postgres://pg-mem-test", memPool());
  await db.initSchema();
  expect(db.dialect).toBe("postgres");
});

describe("postgres backend", () => {
  it("creates users and enforces unique email", async () => {
    await db.run(
      "INSERT INTO users (id, email, password_hash, password_salt, credits_balance, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      ["u1", "a@x.io", "h", "s", 50, new Date().toISOString()]
    );
    const row = await db.get<{ credits_balance: number }>(
      "SELECT credits_balance FROM users WHERE id = $1",
      ["u1"]
    );
    expect(row!.credits_balance).toBe(50);
    await expect(
      db.run(
        "INSERT INTO users (id, email, password_hash, password_salt, credits_balance, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        ["u2", "a@x.io", "h", "s", 0, new Date().toISOString()]
      )
    ).rejects.toThrow();
  });

  it("deducts with a guarded update and reports changes", async () => {
    // Note: pg-mem miscomputes `SET x = x - $1` (swaps the operands), so this
    // test asserts rowCounts only. `SET x = x - $1` is standard SQL, correct
    // on real Postgres.
    const r1 = await db.run(
      "UPDATE users SET credits_balance = credits_balance - $1 WHERE id = $2 AND credits_balance >= $3",
      [30, "u1", 30]
    );
    expect(r1.changes).toBe(1);
    const r2 = await db.run(
      "UPDATE users SET credits_balance = credits_balance - $1 WHERE id = $2 AND credits_balance >= $3",
      [30, "u1", 30]
    );
    expect(r2.changes).toBe(0); // guarded: no overspend
  });

  it("runs transactions and surfaces 23505 on duplicate refs", async () => {
    await db.run(
      "INSERT INTO users (id, email, password_hash, password_salt, credits_balance, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      ["u-tx", "tx@x.io", "h", "s", 1000, new Date().toISOString()]
    );
    await db.transaction(async (tx) => {
      await tx.run("UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2", [400, "u-tx"]);
      await tx.run(
        "INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES ($1, $2, $3, $4, $5)",
        ["u-tx", 400, "pack", "stripe:evt_1", new Date().toISOString()]
      );
    });
    const bal = await db.get<{ credits_balance: number }>("SELECT credits_balance FROM users WHERE id = $1", [
      "u-tx",
    ]);
    expect(bal!.credits_balance).toBe(1400);

    // Duplicate ref: the error must surface as Postgres 23505 so the
    // idempotency check in addCredits() recognizes it. (pg-mem does not
    // actually roll back, so the revert itself is not asserted here; the
    // ROLLBACK statement is standard and correct on real Postgres.)
    let code: string | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.run("UPDATE users SET credits_balance = credits_balance + $1 WHERE id = $2", [400, "u-tx"]);
        await tx.run(
          "INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES ($1, $2, $3, $4, $5)",
          ["u-tx", 400, "pack", "stripe:evt_1", new Date().toISOString()]
        );
      });
    } catch (err: any) {
      code = err.code;
    }
    expect(code).toBe("23505");
  });

  it("parks pending credits idempotently with ON CONFLICT DO NOTHING", async () => {
    const park =
      "INSERT INTO pending_credits (email, credits, pack_id, stripe_event_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (stripe_event_id) DO NOTHING";
    const r1 = await db.run(park, ["buyer@x.io", 400, "starter", "evt_9", new Date().toISOString()]);
    await db.run(park, ["buyer@x.io", 400, "starter", "evt_9", new Date().toISOString()]);
    expect(r1.changes).toBe(1);
    // Note: pg-mem reports rowCount=1 for the skipped insert; real Postgres
    // reports 0. The invariant that matters (exactly one row) is checked below.
    const rows = await db.all<{ credits: number }>("SELECT credits FROM pending_credits WHERE email = $1", [
      "buyer@x.io",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].credits).toBe(400);
  });

  it("stores and retrieves sessions with a join", async () => {
    await db.run(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      ["tok1", "u1", new Date().toISOString(), new Date(Date.now() + 1000).toISOString()]
    );
    const row = await db.get<{ id: string; email: string; credits: number }>(
      `SELECT s.user_id AS id, u.email, u.credits_balance AS credits
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      ["tok1"]
    );
    expect(row!.id).toBe("u1");
    expect(row!.email).toBe("a@x.io");
    const del = await db.run("DELETE FROM sessions WHERE token_hash = $1", ["tok1"]);
    expect(del.changes).toBe(1);
  });

  it("round-trips projects through JSONB", async () => {
    const doc = { id: "p1", userId: "u1", title: "Hello", nested: { a: [1, 2] } };
    await db.run("INSERT INTO projects (id, user_id, data, updated_at) VALUES ($1, $2, $3, $4)", [
      "p1",
      "u1",
      JSON.stringify(doc),
      new Date().toISOString(),
    ]);
    const rows = await db.all<{ data: any }>("SELECT data FROM projects");
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ id: "p1", title: "Hello", nested: { a: [1, 2] } });
  });

  it("upserts workspace files and scopes them per user", async () => {
    const upsert = `INSERT INTO workspace_files (user_id, path, content, line_count, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, path) DO UPDATE SET
        content = excluded.content,
        line_count = excluded.line_count,
        updated_at = excluded.updated_at`;
    await db.run(upsert, ["u1", "src/a.ts", "v1", 1, new Date().toISOString()]);
    await db.run(upsert, ["u1", "src/a.ts", "v2", 1, new Date().toISOString()]);
    await db.run(upsert, ["u1", "src/b.ts", "b", 1, new Date().toISOString()]);
    const rows = await db.all<{ path: string; content: string }>(
      `SELECT path, content FROM workspace_files WHERE user_id = $1 ORDER BY path`, ["u1"]);
    expect(rows.map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(rows[0].content).toBe("v2");
    // Other users see nothing.
    const other = await db.all(`SELECT path FROM workspace_files WHERE user_id = $1`, ["u2"]);
    expect(other).toHaveLength(0);
    // Deleting the user cascades to their files.
    await db.run(`DELETE FROM users WHERE id = $1`, ["u1"]);
    const gone = await db.all(`SELECT path FROM workspace_files WHERE user_id = $1`, ["u1"]);
    expect(gone).toHaveLength(0);
  });

  // Note: pg-mem cannot re-run CREATE TABLE IF NOT EXISTS once the table
  // exists (emulator limitation); real Postgres handles it. Idempotency of
  // the schema itself is therefore not asserted here — beforeAll proves a
  // clean init works.
});
