// The other tests derive their inputs from the limit constants, so they verify
// the mechanism relative to whatever the bound happens to be and would keep
// passing if a bound were raised to uselessness. These pin the values, and pin
// the wall-clock behaviour the values exist to produce.
import { describe, it, expect } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_LINE_CHARS,
  MAX_TOTAL_BYTES,
  MAX_FILES,
  MAX_SCAN_MS,
  runPreFlightScan,
} from "../server/preflight-scan";
import {
  MAX_SCAN_BYTES,
  MAX_SCAN_LINE_CHARS,
  runDeterministicScan,
} from "../server/deterministic-scan";
import { MAX_ZIP_ENTRIES, MAX_ARCHIVE_BYTES } from "../server/routes/workspace";

describe("limit values are pinned", () => {
  // Raising any of these silently is how a DoS fix gets undone. Changing one
  // should require changing this test, which forces the change to be argued.
  it("PreFlight scan limits", () => {
    expect(MAX_FILE_BYTES).toBe(256 * 1024);
    expect(MAX_LINE_CHARS).toBe(20000);
    expect(MAX_TOTAL_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_FILES).toBe(1500);
    expect(MAX_SCAN_MS).toBe(10000);
  });

  it("deterministic scan limits", () => {
    expect(MAX_SCAN_BYTES).toBe(256 * 1024);
    expect(MAX_SCAN_LINE_CHARS).toBe(20000);
  });

  it("ZIP intake limits", () => {
    expect(MAX_ZIP_ENTRIES).toBe(2000);
    expect(MAX_ARCHIVE_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe("wall-clock bounds, independent of the constants", () => {
  // Absolute ceilings. These fail if a limit is raised even if the pins above
  // were updated to match, because the cost is what actually matters.
  it("the deterministic scan survives its worst measured input", () => {
    // "function" plus whitespace is the shape that makes the stub regex
    // backtrack: 82ms at 16KB, 1.3s at 64KB, 11.9s at 128KB before the cap.
    const hostile = "function" + " ".repeat(9 * 1024 * 1024) + "X";
    const started = Date.now();
    const scan = runDeterministicScan(hostile);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(scan.truncated || scan.skippedLines > 0).toBe(true);
  });

  it("the deterministic scan reports reduced coverage rather than hiding it", () => {
    const longLine = "a".repeat(MAX_SCAN_LINE_CHARS + 1);
    const scan = runDeterministicScan(`const a = 1;\n${longLine}\nconst b = 2;`);
    expect(scan.skippedLines).toBe(1);

    const oversize = "const x = 1;\n".repeat(MAX_SCAN_BYTES);
    expect(runDeterministicScan(oversize).truncated).toBe(true);

    const normal = runDeterministicScan("const a = 1;\napp.get('/x', h);\n");
    expect(normal.truncated).toBe(false);
    expect(normal.skippedLines).toBe(0);
  });

  it("a 9MB single-line body is refused quickly by the PreFlight path", () => {
    const started = Date.now();
    const r = runPreFlightScan([{ path: "big.js", content: "a".repeat(9 * 1024 * 1024) }]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.filesScanned).toBe(0);
  });

  it("many individually-legal files cannot block past the time budget", () => {
    // Bytes alone did not bound this: ~16 files of 256KB each sit inside the
    // 4MB budget and still took ~66s before the deadline existed.
    const line = "const x = fetch('/api/a'); // padding\n";
    const content = line.repeat(Math.floor(MAX_FILE_BYTES / line.length) - 1);
    const files = Array.from({ length: 16 }, (_, i) => ({ path: `src/f${i}.ts`, content }));

    const started = Date.now();
    const r = runPreFlightScan(files);
    const elapsed = Date.now() - started;

    // The deadline is checked between batches, so the ceiling is the budget
    // plus one batch. Measured ~14s here against ~66s unbounded.
    expect(elapsed).toBeLessThan(MAX_SCAN_MS * 2.5);
    // Whatever it could not reach is reported, never silently dropped.
    expect(r.filesScanned + r.filesSkipped.length).toBe(files.length);
    expect(r.filesSkipped.some((s) => /time budget/.test(s.reason))).toBe(true);
    expect(r.findings.length).toBeGreaterThan(0);
  });
});
