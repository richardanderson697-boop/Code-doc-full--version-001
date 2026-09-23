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
// Both call initDatabase() per operation on purpose: the store recreates
// itself if data/ is removed while the server is running (ephemeral disks,
// manual cleanup) instead of failing every write until a restart.
export function readProjects() {
  try {
    initDatabase();
    const data = fs.readFileSync(projectsFile(), "utf8");
    return JSON.parse(data);
  } catch (error) {
    log.error("Failed to read projects:", error);
    return [];
  }
}

export function writeProjects(projects: any[]) {
  try {
    initDatabase();
    fs.writeFileSync(projectsFile(), JSON.stringify(projects, null, 2), "utf8");
    return true;
  } catch (error) {
    log.error("Failed to write projects:", error);
    return false;
  }
}

export function migrateProjects() {
  try {
    const projects = readProjects();
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
      writeProjects(migratedProjects);
    }
  } catch (e) {
    log.error("Migration failed:", e);
  }
}


// API Routes


// Boot-time bootstrap: ensure the store exists, then run one-off migrations.
export function initProjectsStore(): void {
  initDatabase();
  migrateProjects();
}
