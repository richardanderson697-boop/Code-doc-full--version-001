# Vendored PreFlight engine

`vendor/` contains the deterministic scan engine from
[PreFlight](https://github.com/midatlanticAI/PreFlight), the free in-browser
static security audit by Mid-Atlantic AI, live at
[preflight.midatlantic.ai](https://preflight.midatlantic.ai).

## Licensing

Two licenses apply, both reproduced in this directory:

- **`LICENSE` (MIT)** — the engine code, which is everything under
  `vendor/lib/`.
- **`LICENSE-DATA` (CC-BY-4.0)** — the curated threat-intelligence data
  manifest, which is `vendor/data/compromised-packages.js`. Attribution to
  Mid-Atlantic AI is required if that data is redistributed or reused.

- Source commit: `3289d5617b54582ebb20064e1ec255ff8b7f1551`
- Entry point: `vendor/lib/cockpit-scan.js` — PreFlight's stable embedding
  seam for host applications. One call: `scan(files) -> { findings, score, ... }`.
- Contents: the exact relative-import closure of `cockpit-scan.js`
  (117 files: probe registry, 104 probes, threat-intel manifests, scoring).
  Nothing else from the upstream repo is included; in particular the
  deliberately-vulnerable test fixtures are NOT vendored.
- Runtime dependencies: `acorn`, `acorn-jsx`, `acorn-loose` (declared by the
  engine itself in `ENGINE_RUNTIME_DEPS`). Do not infer dependencies by
  parsing imports out of vendored probe files — probe pattern data contains
  import-shaped strings by design.

## Updating

Re-run the closure copy against a newer PreFlight checkout, update the commit
hash above, and re-copy `LICENSE` and `LICENSE-DATA`. Do not hand-edit files
under `vendor/` — fixes belong upstream.

## Local integration points

- `../preflight-scan.ts` — typed adapter over `scan()` used by the routes.
- `/api/cold-audit` — scans the submitted file, merges findings into the
  evidence sheet, and feeds them to the LLM pass as ground truth.
- `/api/project-intelligence` — scans the whole uploaded workspace and
  returns the deterministic findings alongside the LLM report.
