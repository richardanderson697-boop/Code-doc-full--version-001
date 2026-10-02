// JSON-file persistence for the project history ledger.
import path from "path";
import fs from "fs";
import { log } from "./logger";

// Resolved per call rather than at import, and overridable by CODEDOC_DATA_DIR.
// Tests need somewhere disposable to write: pointing them at the default meant
// a test run deleted the developer's real project history, and because data/ is
// gitignored the loss was invisible in git status.
export function dataDir(): string {
  return process.env.CODEDOC_DATA_DIR || path.join(process.cwd(), "data");
}

function projectsFile(): string {
  return path.join(dataDir(), "projects.json");
}

// Ensure database directory and file exist
export function initDatabase() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(projectsFile())) {
    fs.writeFileSync(projectsFile(), JSON.stringify([], null, 2), "utf8");
  }
}


// Project schema helper functions.
// SQLite backend: the JSON file store from the original build (tests and
// local dev exercise this path).
// Postgres backend: a projects table; the whole ledger is replaced in one
// transaction, mirroring the read-modify-write cycle the routes perform.
export async function readProjects(): Promise<any[]> {
  const { getDb } = await import("./store");
  const db = getDb();
  if (db.dialect === "postgres") {
    const rows = await db.all<{ data: any }>("SELECT data FROM projects");
    return rows.map((r) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data));
  }
  try {
    initDatabase();
    const data = fs.readFileSync(projectsFile(), "utf8");
    return JSON.parse(data);
  } catch (error) {
    log.error("Failed to read projects:", error);
    return [];
  }
}

export async function writeProjects(projects: any[]): Promise<boolean> {
  const { getDb } = await import("./store");
  const db = getDb();
  if (db.dialect === "postgres") {
    try {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM projects");
        for (const p of projects) {
          await tx.run("INSERT INTO projects (id, user_id, data, updated_at) VALUES ($1, $2, $3, $4)", [
            String(p.id ?? `project_${Date.now()}_${Math.random().toString(36).slice(2)}`),
            p.userId ?? null,
            JSON.stringify(p),
            new Date().toISOString(),
          ]);
        }
      });
      return true;
    } catch (error) {
      log.error("Failed to write projects:", error);
      return false;
    }
  }
  try {
    initDatabase();
    fs.writeFileSync(projectsFile(), JSON.stringify(projects, null, 2), "utf8");
    return true;
  } catch (error) {
    log.error("Failed to write projects:", error);
    return false;
  }
}

export async function migrateProjects(): Promise<void> {
  try {
    const projects = await readProjects();
    let migrated = false;
    
    const purposeRegex = /====\s*PURPOSE\s*====|====\s*PURPOSE\s*|===\s*PURPOSE\s*===|##\s*PURPOSE|#\s*PURPOSE/i;
    const codeRegex = /====\s*CODE\s*====|====\s*CODE\s*|===\s*CODE\s*===|##\s*CODE|#\s*CODE/i;

    const migratedProjects = projects.map((project: any) => {
      if (project.code === "" && project.purpose) {
        const fullText = project.purpose;
        const codeMatch = fullText.match(codeRegex);
        if (codeMatch) {
          const codeIndex = codeMatch.index ?? -1;
          const codeLength = codeMatch[0].length;
          
          let purposeText = fullText.substring(0, codeIndex).trim();
          let codeText = fullText.substring(codeIndex + codeLength).trim();
          
          // Clean purposeText of PURPOSE marker if it starts with it
          const purposeMatch = purposeText.match(purposeRegex);
          if (purposeMatch && purposeMatch.index === 0) {
            purposeText = purposeText.substring(purposeMatch[0].length).trim();
          }
          
          // Clean code of markdown blocks
          if (codeText.startsWith("```typescript")) codeText = codeText.substring("```typescript".length);
          else if (codeText.startsWith("```tsx")) codeText = codeText.substring("```tsx".length);
          else if (codeText.startsWith("```javascript")) codeText = codeText.substring("```javascript".length);
          else if (codeText.startsWith("```")) codeText = codeText.substring("```".length);
          
          if (codeText.endsWith("```")) codeText = codeText.substring(0, codeText.length - 3);

          migrated = true;
          return {
            ...project,
            purpose: purposeText,
            code: codeText.trim(),
            updatedAt: new Date().toISOString()
          };
        }
      }
      return project;
    });

    if (migrated) {
      log.info("Migrating database projects to split purpose and code...");
      await writeProjects(migratedProjects);
    }
  } catch (e) {
    log.error("Migration failed:", e);
  }
}


// API Routes


// Boot-time bootstrap: ensure the store exists, then run one-off migrations.
export async function initProjectsStore(): Promise<void> {
  initDatabase();
  await migrateProjects();
}

// Warn loudly when the data directory is not on a persistent volume. On
// Railway the container filesystem is ephemeral: without a volume mounted at
// CODEDOC_DATA_DIR, every redeploy wipes users, sessions, and credit ledgers.
// Moot when Postgres is the store (DATABASE_URL set): nothing persistent
// lives on disk then.
// Linux-only check; any failure just skips the warning.
export function warnIfEphemeralDataDir(): void {
  try {
    if (process.env.DATABASE_URL) return;
    if (process.platform !== "linux") return;
    const dir = path.resolve(dataDir());
    const mounts = fs.readFileSync("/proc/mounts", "utf8").split("\n");
    const table: string[] = [];
    let onVolume = false;
    for (const line of mounts) {
      const parts = line.split(" ");
      if (parts.length < 3) continue;
      const mountPoint = parts[1].replace(/\\040/g, " ");
      table.push(`${parts[0]} -> ${mountPoint} [${parts[2]}]`);
      if (mountPoint !== "/" && (dir === mountPoint || dir.startsWith(mountPoint + "/"))) {
        onVolume = true;
      }
    }
    // Always visible at startup: when /data is not persistent we need to see
    // WHERE the platform actually mounted the volume (if at all), so the
    // mount can be fixed instead of guessed at.
    log.info(`Startup mount table: ${table.join(" | ")}`);
    if (!onVolume) {
      log.warn(
        `DATA LOSS RISK: ${dir} is not on a persistent volume. Every redeploy will wipe users, ` +
          `sessions, and credit ledgers. Attach a Railway volume at this path.`
      );
    } else {
      log.info(`Data dir ${dir} is on a persistent volume.`);
    }
  } catch {
    // /proc/mounts unreadable (non-Linux, sandboxed): stay quiet.
  }
}
