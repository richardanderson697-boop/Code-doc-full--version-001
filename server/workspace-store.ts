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
}

/** Atomically replace the whole workspace (ZIP upload): delete-all + insert inside one transaction. */
export async function replaceWorkspaceFiles(
  userId: string,
  files: { path: string; content: string }[]
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
  });
}
