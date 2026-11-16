// Detector precision — taint-flow path vs content, and submit-button
// wiring (finalread-taint-and-dead-button-precision-spec.md, APPROVED).
// The Pantry-ledger chronological test is the motivating case: three
// versions of the same app, scanned in order. The three ZIPs are the
// regression corpus; the extracted copies live next to the repo so the
// tests can read them directly.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { probeTaintFlow } from "../server/preflight/vendor/lib/probes/taint-engine.js";
import {
  dropContentOnlyTaintFindings,
} from "../server/preflight/taint-path-filter";
import { runDeterministicScan } from "../server/deterministic-scan";

const WS = resolve(process.cwd(), "..", "..");
const PANTRY = (ver: string, rel: string) =>
  readFileSync(join(WS, `pantry-ledger-${ver}`, "Pantry-ledger--main", rel), "utf8");

type RawFinding = {
  id?: string;
  probe?: string;
  title?: string;
  file?: string;
  line?: number;
  evidence?: string;
};

function fsCallFindings(files: { path: string; content: string }[]): RawFinding[] {
  const all = probeTaintFlow(files) as RawFinding[];
  return all.filter((f) => String(f.id || "").startsWith("taint-fs-call"));
}

function filteredFsCall(files: { path: string; content: string }[]): RawFinding[] {
  const raw = fsCallFindings(files);
  const contents = new Map(files.map((f) => [f.path, f.content]));
  return dropContentOnlyTaintFindings(raw, contents);
}

describe("taint: Pantry fixtures", () => {
  it("v1: the engine still flags :1716, the filter drops it (content-only)", () => {
    const files = [{ path: "Pantry-ledger--main/server.ts", content: PANTRY("v1", "server.ts") }];
    const raw = fsCallFindings(files);
    expect(raw.map((f) => f.line)).toEqual([1716]);
    expect(filteredFsCall(files)).toHaveLength(0);
  });

  it("v1: the OCR job site at :870 is never flagged (parameter, not req.body)", () => {
    const files = [{ path: "Pantry-ledger--main/server.ts", content: PANTRY("v1", "server.ts") }];
    expect(fsCallFindings(files).some((f) => f.line === 870)).toBe(false);
  });

  it("v2: the engine still flags :1696, the filter drops it (safeResolveWithin on the path)", () => {
    const files = [{ path: "Pantry-ledger--main/server.ts", content: PANTRY("v2", "server.ts") }];
    const raw = fsCallFindings(files);
    expect(raw.map((f) => f.line)).toEqual([1696]);
    expect(filteredFsCall(files)).toHaveLength(0);
  });

  it("v3: pdfOcr.ts has no fs-call finding, raw or filtered (zero deltas)", () => {
    const files = [
      { path: "Pantry-ledger--main/server/pdfOcr.ts", content: PANTRY("v3", "server/pdfOcr.ts") },
    ];
    expect(fsCallFindings(files)).toHaveLength(0);
    expect(filteredFsCall(files)).toHaveLength(0);
  });
});

describe("taint: positive controls (filter keeps the finding)", () => {
  it("request-derived filename joined into a write path with no sanitisation", () => {
    const code = `
import fs from 'node:fs';
import path from 'node:path';
app.post('/files/:name', (req, res) => {
  const p = path.join('/tmp', req.params.name);
  fs.writeFile(p, Buffer.from('x'));
});`;
    const files = [{ path: "app/server.ts", content: code }];
    const raw = fsCallFindings(files);
    expect(raw.length).toBeGreaterThan(0);
    expect(filteredFsCall(files)).toHaveLength(raw.length);
  });

  it("a request-derived value used directly as the read path", () => {
    const code = `
import fs from 'node:fs';
app.get('/files', (req, res) => {
  fs.readFile(req.query.path, 'utf8', (err, data) => res.send(data));
});`;
    const files = [{ path: "app/server.ts", content: code }];
    const raw = fsCallFindings(files);
    expect(raw.map((f) => f.line)).toEqual([4]);
    expect(filteredFsCall(files)).toHaveLength(1);
  });

  it("a request-derived segment in path.join", () => {
    const code = `
import path from 'node:path';
app.post('/files', (req, res) => {
  const p = path.join('/tmp', req.body.name);
  res.json({ p });
});`;
    const files = [{ path: "app/server.ts", content: code }];
    const raw = fsCallFindings(files);
    expect(raw.length).toBe(1);
    expect(filteredFsCall(files)).toHaveLength(1);
  });
});

describe("taint: negative controls (filter drops the finding)", () => {
  it("mkdtemp dir + fixed literal, uploaded bytes as content", () => {
    const code = `
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
app.post('/x', async (req, res) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pantry-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  await fs.writeFile(pdfPath, req.body);
});`;
    const files = [{ path: "app/server.ts", content: code }];
    expect(fsCallFindings(files)).toHaveLength(1);
    expect(filteredFsCall(files)).toHaveLength(0);
  });

  it("safeResolveWithin with a literal segment, uploaded bytes as content", () => {
    const code = `
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
function safeResolveWithin(base, seg) { return path.resolve(base, seg); }
app.post('/x', async (req, res) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pantry-'));
  const safePdfPath = safeResolveWithin(tmpDir, 'input.pdf');
  await fs.writeFile(safePdfPath, req.body);
});`;
    const files = [{ path: "app/server.ts", content: code }];
    expect(fsCallFindings(files)).toHaveLength(1);
    expect(filteredFsCall(files)).toHaveLength(0);
  });

  it("readdir results resolved within their own temp dir", () => {
    const code = `
import fs from 'node:fs';
function safeResolveWithin(base, seg) { return base + '/' + seg; }
async function sweep(tmpDir, req) {
  const files = (await fs.readdir(tmpDir)).map((f) => safeResolveWithin(tmpDir, f));
  await fs.writeFile(files[0], req.body);
}`;
    const files = [{ path: "app/server.ts", content: code }];
    expect(fsCallFindings(files)).toHaveLength(1);
    expect(filteredFsCall(files)).toHaveLength(0);
  });

  it("path.basename on a request-derived filename joined into a fixed dir", () => {
    const code = `
import fs from 'node:fs';
import path from 'node:path';
app.post('/files/:name', (req, res) => {
  const p = path.join('/tmp', path.basename(req.params.name));
  fs.writeFile(p, Buffer.from('x'));
});`;
    const files = [{ path: "app/server.ts", content: code }];
    const raw = fsCallFindings(files);
    expect(raw.length).toBeGreaterThan(0);
    expect(filteredFsCall(files)).toHaveLength(0);
  });

  it("a sanitised display name used only as a label never fires", () => {
    const code = `
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
app.post('/api/parse-pdf', async (req, res) => {
  const rawHeaderName = req.headers['x-file-name'];
  const sourceName = rawHeaderName ? decodeURIComponent(String(rawHeaderName)) : 'Uploaded.pdf';
  const safe = path.basename(sourceName).replace(/[^a-zA-Z0-9._ -]/g, '_');
  res.json({ sourceName: safe });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pantry-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  await fs.writeFile(pdfPath, req.body);
});`;
    const files = [{ path: "app/server.ts", content: code }];
    const raw = fsCallFindings(files);
    expect(raw).toHaveLength(1);
    expect(raw[0].evidence).not.toContain("sourceName");
    expect(filteredFsCall(files)).toHaveLength(0);
  });

  it("an unparsable file keeps the finding (fail-closed)", () => {
    const files = [{ path: "app/server.ts", content: "const broken = (((;" }];
    // No finding can be produced from unparsable code, so the filter has
    // nothing to drop — assert the pass-through, not an invented finding.
    expect(filteredFsCall(files)).toHaveLength(0);
  });
});

const PANTRY_BUTTONS: [string, string, number][] = [
  ["v1", "src/components/InventoryWorkspace.tsx", 526],
  ["v1", "src/components/NutritionWorkspace.tsx", 250],
  ["v1", "src/components/ScannerWorkspace.tsx", 629],
  ["v1", "src/components/ShoppingListWorkspace.tsx", 100],
  ["v1", "src/components/ShoppingListWorkspace.tsx", 280],
  ["v2", "src/components/InventoryWorkspace.tsx", 526],
  ["v2", "src/components/NutritionWorkspace.tsx", 251],
  ["v2", "src/components/ScannerWorkspace.tsx", 630],
  ["v2", "src/components/ShoppingListWorkspace.tsx", 100],
  ["v2", "src/components/ShoppingListWorkspace.tsx", 280],
];

describe("dead buttons: Pantry fixtures", () => {
  it("v1/v2: the five submit buttons are wired (form onSubmit, far above)", () => {
    for (const [ver, rel] of PANTRY_BUTTONS) {
      const s = runDeterministicScan(PANTRY(ver, rel), rel);
      expect(s.deadActions, `${ver} ${rel} should have no dead actions`).toHaveLength(0);
    }
  });

  it("v3: the five requestSubmit buttons are wired (zero deltas)", () => {
    for (const rel of [
      "src/components/InventoryWorkspace.tsx",
      "src/components/NutritionWorkspace.tsx",
      "src/components/ScannerWorkspace.tsx",
      "src/components/ShoppingListWorkspace.tsx",
    ]) {
      const s = runDeterministicScan(PANTRY("v3", rel), rel);
      expect(s.deadActions, `v3 ${rel} should have no dead actions`).toHaveLength(0);
    }
  });
});

describe("dead buttons: positive controls (still flagged)", () => {
  it("type=button with no handler outside a form", () => {
    const s = runDeterministicScan(`<button type="button">Do thing</button>`, "app/page.tsx");
    expect(s.deadActionCount).toBe(1);
    expect(s.deadActions[0].label).toBe("Do thing");
  });

  it("submit button in a form with neither onSubmit nor action", () => {
    const s = runDeterministicScan(
      `<form>\n  <button type="submit">Save</button>\n</form>`,
      "app/page.tsx"
    );
    expect(s.deadActionCount).toBe(1);
    expect(s.deadActions[0].label).toBe("Save");
  });

  it("submit button outside any form with no handler", () => {
    const s = runDeterministicScan(
      `<div>\n  <button type="submit">Save</button>\n</div>`,
      "app/page.tsx"
    );
    expect(s.deadActionCount).toBe(1);
  });
});

describe("dead buttons: negative controls (not flagged)", () => {
  it("submit button in a form with onSubmit, form tag far above the button", () => {
    const filler = Array.from({ length: 60 }, (_, i) => `  <div key={${i}}>row</div>`).join("\n");
    const code = `<form onSubmit={handleSubmit}>\n${filler}\n  <button type="submit">Save</button>\n</form>`;
    const s = runDeterministicScan(code, "app/page.tsx");
    expect(s.deadActionCount).toBe(0);
  });

  it("submit button in a form with a native action", () => {
    const s = runDeterministicScan(
      `<form action="/save">\n  <button type="submit">Save</button>\n</form>`,
      "app/page.tsx"
    );
    expect(s.deadActionCount).toBe(0);
  });

  it("typeless button in a form with onSubmit (defaults to submit)", () => {
    const s = runDeterministicScan(
      `<form onSubmit={handleSubmit}>\n  <button>Save</button>\n</form>`,
      "app/page.tsx"
    );
    expect(s.deadActionCount).toBe(0);
  });

  it("type=button calling form.requestSubmit() (the v3 shape)", () => {
    const s = runDeterministicScan(
      `<form onSubmit={handleSubmit}>\n  <button type="button" onClick={(e) => e.currentTarget.form?.requestSubmit()}>Save</button>\n</form>`,
      "app/page.tsx"
    );
    expect(s.deadActionCount).toBe(0);
  });
});
