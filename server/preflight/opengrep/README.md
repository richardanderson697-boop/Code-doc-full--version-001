# Opengrep layer (PreFlight)

AST-aware security rules that run alongside the vendored PreFlight engine.
Same findings shape, merged into the same report and prompt digest.

## What it is

- **Engine:** [Opengrep](https://opengrep.dev) v1.30.0 (pinned), the LGPL-2.1
  community fork of Semgrep's engine. Runs as a subprocess (`./bin/opengrep`),
  so the LGPL does not reach this codebase.
- **Rules:** `rules/` — our own YAML pack, ids prefixed `gv-`. Findings carry
  CWE/OWASP metadata from the rule and appear as `opengrep:<rule-id>` probes.

## Licensing rule (do not break this)

The Opengrep **engine** is fine to run commercially. Semgrep's **official rule
registry** (`p/...`, `--config auto`) is under the Semgrep Rules License v1.0
(Dec 2024): internal business use only, running it on customers' code as a
service is prohibited. So: **only our own rules, never registry packs.**

## Install

`scripts/install-opengrep.sh` (pinned version, idempotent) runs via the
`postinstall` hook, so Railway/Nixpacks images get the binary at build time.
Local dev without the binary is fine: the scan degrades to the vendored
engine only and logs one warning.

Env overrides: `OPENGREP_PATH`, `OPENGREP_RULES_DIR`, `OPENGREP_TIMEOUT_MS`,
`OPENGREP_DISABLED=1` (tests / emergency kill-switch).

## Adding a rule

1. Add a `gv-`-prefixed rule to `rules/gradevibes-js.yaml` with `cwe`,
   `owasp`, and `fix` metadata. `gradevibes_severity` optionally pins the
   PreFlight severity (critical/high/medium/low/info).
2. Test it against a fixture:
   `bin/opengrep scan --config server/preflight/opengrep/rules --json --quiet <dir>`
3. Add a case to `test/opengrep-runner.test.ts`.

Note: JSX attribute patterns need element context —
`<$TAG dangerouslySetInnerHTML={$X} />`, not the bare attribute.

## Known follow-ups

- Opengrep findings do not move the PreFlight score yet (unified scoring).
- Engine and Opengrep findings are not deduplicated (probe names differ).
- ~3s fixed subprocess overhead per scan; the scan still runs on the request
  thread (same as the vendored engine — the real fix is off-thread for both).
