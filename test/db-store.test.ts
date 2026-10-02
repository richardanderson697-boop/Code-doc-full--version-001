// The project store must survive its directory disappearing underneath it.
// The refactor briefly moved initDatabase() to boot-only, which made every
// write fail permanently once data/ was removed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { readProjects, writeProjects, initProjectsStore, dataDir } from "../server/db";

// Resolved from the store itself, which the test setup points at a temp dir.
// Hardcoding process.cwd()/data here meant `npm test` deleted the developer's
// real project history, invisibly, because data/ is gitignored.
const DATA_DIR = dataDir();

describe("project store durability", () => {
  beforeEach(async () => {
    await initProjectsStore();
  });

  afterEach(async () => {
    // Leave the store in a valid state for the next test / dev run.
    await initProjectsStore();
  });

  it("writes and reads back a project", async () => {
    const ok = await writeProjects([{ id: "vibe_test_1", title: "T" }]);
    expect(ok).toBe(true);
    expect(await readProjects()).toEqual([{ id: "vibe_test_1", title: "T" }]);
  });

  it("recreates the store when data/ is deleted mid-run", async () => {
    expect(await writeProjects([{ id: "before" }])).toBe(true);

    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    expect(fs.existsSync(DATA_DIR)).toBe(false);

    // Without the per-call initDatabase(), this write throws ENOENT and the
    // store never recovers until the process restarts.
    expect(await writeProjects([{ id: "after" }])).toBe(true);
    expect(fs.existsSync(DATA_DIR)).toBe(true);
    expect(await readProjects()).toEqual([{ id: "after" }]);
  });

  it("reads an empty list when data/ is deleted rather than throwing", async () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    expect(await readProjects()).toEqual([]);
    expect(fs.existsSync(DATA_DIR)).toBe(true);
  });
});
