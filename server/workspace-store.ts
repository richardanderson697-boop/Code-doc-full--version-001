// Postgres/SQLite-backed per-user workspace file store.
//
// The workspace used to live on disk (uploaded_project/<userId>/), which
// Railway wipes on every redeploy — generated projects and uploads silently
// vanished with each push. Files now live in the workspace_files table, next
// to everything else, and survive deploys.
//
// SQL is written once with Postgres-style $1 placeholders; the SQLite
// backend rewrites them to ?. ON CONFLICT upsert works on both.
import { getDb } from "./store";
import { countLines, isWorkspaceFileExt } from "./workspace";

export interface WorkspaceFileRow {
  path: string;
  content: string;
  lineCount: number;
}

const SELECT_COLS = `path, content, line_count AS "lineCount"`;

/** All of the user's workspace files, ordered by path. Extension-filtered, like the old disk scanner. */
export async function listWorkspaceFiles(userId: string): Promise<WorkspaceFileRow[]> {
  const rows = await getDb().all<WorkspaceFileRow>(
    `SELECT ${SELECT_COLS} FROM workspace_files WHERE user_id = $1 ORDER BY path`,
    [userId]
  );
  return rows.filter((r) => isWorkspaceFileExt(r.path));
}

/** A single workspace file by its canonical relative path. No extension filter (mirrors the old direct file read). */
export async function getWorkspaceFile(userId: string, relPath: string): Promise<WorkspaceFileRow | undefined> {
  return getDb().get<WorkspaceFileRow>(
    `SELECT ${SELECT_COLS} FROM workspace_files WHERE user_id = $1 AND path = $2`,
    [userId, relPath]
  );
}

/** Insert or overwrite one file. The path must already be cleaned with cleanWorkspacePath. */
export async function saveWorkspaceFile(userId: string, relPath: string, content: string): Promise<void> {
  await getDb().run(
    `INSERT INTO workspace_files (user_id, path, content, line_count, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, path) DO UPDATE SET
       content = excluded.content,
       line_count = excluded.line_count,
       updated_at = excluded.updated_at`,
    [userId, relPath, content, countLines(content), new Date().toISOString()]
  );
}

export async function deleteWorkspaceFile(userId: string, relPath: string): Promise<void> {
  await getDb().run(`DELETE FROM workspace_files WHERE user_id = $1 AND path = $2`, [userId, relPath]);
}

export async function clearWorkspaceFiles(userId: string): Promise<void> {
  await getDb().run(`DELETE FROM workspace_files WHERE user_id = $1`, [userId]);
  await clearWorkspaceSource(userId);
}

/** Where the current workspace content came from. One row per user, always
 * describing the CURRENT files: replacing the workspace replaces (or
 * clears) the source with it, so a stale URL can never title new content.
 * Lives in its own table, never in workspace_files, so it can never be
 * scanned, counted, or cited as code. */
export interface WorkspaceSource {
  kind: "github" | "zip";
  owner?: string;
  repo?: string;
  url?: string;
  filename?: string;
}

export async function getWorkspaceSource(
  userId: string
): Promise<WorkspaceSource | undefined> {
  const row = await getDb().get<{
    kind: string;
    owner: string | null;
    repo: string | null;
    url: string | null;
    filename: string | null;
  }>(
    `SELECT kind, owner, repo, url, filename FROM workspace_sources WHERE user_id = $1`,
    [userId]
  );
  if (!row || (row.kind !== "github" && row.kind !== "zip")) return undefined;
  return {
    kind: row.kind,
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.repo ? { repo: row.repo } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.filename ? { filename: row.filename } : {}),
  };
}

export async function clearWorkspaceSource(userId: string): Promise<void> {
  await getDb().run(`DELETE FROM workspace_sources WHERE user_id = $1`, [userId]);
}

/** Atomically replace the whole workspace (ZIP upload): delete-all + insert inside one transaction.
 * The source rides in the same transaction: pass the new source, or
 * nothing when the origin is unknown, which clears any stale source. */
export async function replaceWorkspaceFiles(
  userId: string,
  files: { path: string; content: string }[],
  source?: WorkspaceSource | null
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.run(`DELETE FROM workspace_files WHERE user_id = $1`, [userId]);
    for (const f of files) {
      await tx.run(
        `INSERT INTO workspace_files (user_id, path, content, line_count, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, f.path, f.content, countLines(f.content), new Date().toISOString()]
      );
    }
    if (source) {
      await tx.run(
        `INSERT INTO workspace_sources (user_id, kind, owner, repo, url, filename, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET
           kind = excluded.kind,
           owner = excluded.owner,
           repo = excluded.repo,
           url = excluded.url,
           filename = excluded.filename,
           updated_at = excluded.updated_at`,
        [
          userId,
          source.kind,
          source.owner ?? null,
          source.repo ?? null,
          source.url ?? null,
          source.filename ?? null,
          new Date().toISOString(),
        ]
      );
    } else {
      await tx.run(`DELETE FROM workspace_sources WHERE user_id = $1`, [userId]);
    }
  });
}
