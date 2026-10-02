// Self-install tests: the server downloads the pinned engine binary in the
// background when it is missing. The "binary" here is a shell script served
// by a local HTTP server (OPENGREP_DOWNLOAD_BASE_URL), so no network access
// is needed. Runs in its own file/worker because it chdirs into a temp dir.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "/home/hatch/workspace/code-doc/Code-Doc-main";
const FAKE_BINARY = '#!/bin/sh\necho "1.30.0"\n';

let server: Server | null = null;
let baseUrl = "";
const savedCwd = process.cwd();
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(name: string) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
}

async function startFakeServer(): Promise<void> {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(FAKE_BINARY);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  baseUrl = `http://127.0.0.1:${port}`;
}

afterEach(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (server) {
    server.close();
    server = null;
  }
});

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return existsSync(path);
}

describe("opengrep self-install", () => {
  it(
    "downloads the binary in the background and the resolver picks it up",
    async () => {
      await startFakeServer();
      const workdir = mkdtempSync(join(tmpdir(), "og-autoinstall-"));
      try {
        for (const k of ["OPENGREP_PATH", "OPENGREP_DISABLED", "OPENGREP_NO_AUTOINSTALL", "OPENGREP_DOWNLOAD_BASE_URL", "OPENGREP_RULES_DIR"]) saveEnv(k);
        delete process.env.OPENGREP_PATH;
        delete process.env.OPENGREP_DISABLED;
        delete process.env.OPENGREP_NO_AUTOINSTALL;
        process.env.OPENGREP_DOWNLOAD_BASE_URL = baseUrl;
        process.env.OPENGREP_RULES_DIR = join(REPO, "server", "preflight", "opengrep", "rules");
        process.chdir(workdir);

        const { ensureOpengrepBinary, resolveOpengrepBinary } = await import(
          "../server/preflight/opengrep/runner"
        );
        expect(resolveOpengrepBinary()).toBeNull();
        ensureOpengrepBinary();

        const dest = join(workdir, "bin", "opengrep");
        expect(await waitFor(dest, 15000)).toBe(true);
        // The downloaded file really executes and reports the pinned version.
        const out = execFileSync(dest, ["--version"], { encoding: "utf8" });
        expect(out.trim()).toBe("1.30.0");
        // The resolver now finds it (negative cache was dropped on install).
        expect(resolveOpengrepBinary()).toBe(dest);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    },
    30000
  );

  it("does not download when OPENGREP_NO_AUTOINSTALL=1", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "og-noinstall-"));
    try {
      for (const k of ["OPENGREP_PATH", "OPENGREP_DISABLED", "OPENGREP_NO_AUTOINSTALL"]) saveEnv(k);
      delete process.env.OPENGREP_PATH;
      delete process.env.OPENGREP_DISABLED;
      process.env.OPENGREP_NO_AUTOINSTALL = "1";
      process.chdir(workdir);

      const { ensureOpengrepBinary } = await import("../server/preflight/opengrep/runner");
      ensureOpengrepBinary();
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(join(workdir, "bin", "opengrep"))).toBe(false);
      expect(existsSync(join(workdir, "bin", "opengrep.part"))).toBe(false);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 15000);
});
