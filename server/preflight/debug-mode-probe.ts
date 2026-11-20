// First-party probe: debug mode (finalread-gap-detectors-spec.md Item 3).
//
// A debug/development flag enabled where it would apply in production
// (JS/TS only — the vendored Python probe already covers Flask/Django).
//   - DEBUG=true / 1 / yes (a truthy boolean) or a bare DEBUG in a
//     production-relevant env file (.env.production), or
//   - NODE_ENV set to 'development' in a production config, deploy
//     config, or server entry, or
//   - a framework debug flag in server code: Express app.set('env',
//     'development') or app.set('debug', true), or a `debug: true` in a
//     server/framework config object.
//
// Excluded (never a finding): .env.example / .env.sample (templates),
// test/spec/fixture files, dev-only config, a debug flag guarded so it
// only applies outside production, and a DEBUG log namespace
// (DEBUG=app:*, DEBUG=* — the `debug` package's log filter).
//
// Precision only (Richard, standing): when the probe cannot establish
// whether the flag applies in production — a plain .env whose production
// status is ambiguous, or a flag inside a condition it cannot evaluate —
// it routes to "Needs developer verification" (unverified: true + the
// specific question in remediation), never silently drops and never
// asserts a production exposure it cannot see. The vendored engine and
// the Python debug probe are untouched.
import {
  parseFile,
  readDottedName,
  sourceTextOf,
  type AstNode,
} from "./ast-util";
import { isTestFile } from "./vendor/lib/file-filter.js";
import type { PreFlightFinding } from "../../shared/preflight-types";
import type { ScanInputFile } from "../preflight-scan";

export const DEBUG_MODE_PROBE = "Debug Mode";

export const DEBUG_ENV_QUESTION =
  "Is this .env file the one deployed to production, or a development-only file? Point at the deploy config that settles it.";

export const DEBUG_CODE_QUESTION =
  "Does this debug flag apply when the app runs in production, or only in development? Point at the condition or deploy config that settles it.";

// Env files that are templates or dev-only — never a finding.
const EXCLUDED_ENV_RE = /(^|\/)\.env\.(example|sample|local|development|dev|test)$/i;
// Production-relevant env files — a debug flag here is a liability.
const PROD_ENV_RE = /(^|\/)\.env\.(production|prod|staging|stage)$/i;
// A plain .env — production status ambiguous, routes to verification.
const PLAIN_ENV_RE = /(^|\/)\.env$/i;

// A debug flag in a server/framework config object only counts in a
// config or server-entry file (a `debug: true` in a test helper or a
// logger config is not a framework debug flag): under a server/
// directory, a *.config.* file, or a server/app/index entry file.
function isConfigOrServerFile(path: string): boolean {
  if (/(^|\/)server\//i.test(path)) return true;
  if (/(^|\/)[^/]*\.config\.[jt]sx?$/i.test(path)) return true;
  if (/(^|\/)(server|app|index)\.[jt]sx?$/i.test(path)) return true;
  return false;
}

function isEnvFile(path: string): boolean {
  return /(^|\/)\.env(\.|$)/.test(path);
}

// Parse one env-file line into [key, value] (value: first token after
// "=", quotes stripped; null when the line is a comment/blank). A bare
// key with no "=" returns [key, null].
function parseEnvLine(line: string): [string, string | null] | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const eq = t.indexOf("=");
  if (eq === -1) return [t, null];
  const key = t.slice(0, eq).trim();
  if (!key) return null;
  let value = t.slice(eq + 1).trim();
  // Strip an inline comment only after a quoted value; an unquoted
  // value runs to end of line (dotenv behaviour).
  if (value.startsWith('"') || value.startsWith("'")) {
    const q = value[0];
    const end = value.indexOf(q, 1);
    value = end === -1 ? value.slice(1) : value.slice(1, end);
  } else {
    value = value.split(/\s+/)[0] ?? "";
    const hash = value.indexOf("#");
    if (hash !== -1) value = value.slice(0, hash);
  }
  return [key, value];
}

// Is this value a truthy debug boolean (true/1/yes/on), a bare flag
// (no value), or a log namespace (app:*, *)? Returns "truthy" | "bare" |
// "namespace" | "falsy".
function debugValueKind(value: string | null): "truthy" | "bare" | "namespace" | "falsy" {
  if (value === null) return "bare";
  const v = value.toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "no" || v === "off") return "falsy";
  if (v === "true" || v === "1" || v === "yes" || v === "on") return "truthy";
  if (v.includes("*") || v.includes(":")) return "namespace";
  return "falsy";
}

// Walk with an ancestor stack (for the dev-guard check).
function walkWithAncestors(
  node: AstNode,
  ancestors: AstNode[],
  visit: (n: AstNode, ancestors: AstNode[]) => void
): void {
  if (!node || typeof node !== "object") return;
  visit(node, ancestors);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) walkWithAncestors(child, [...ancestors, node], visit);
    } else if (val && typeof val === "object") {
      walkWithAncestors(val, [...ancestors, node], visit);
    }
  }
}

// How an enclosing if-condition restricts the flag:
//   "dev" — the flag only applies outside production (skip).
//   "prod" — the flag applies in production (flag).
//   "other" — a condition the probe cannot evaluate (verification).
//   null — no enclosing if (flag).
function guardKind(ancestors: AstNode[], content: string): "dev" | "prod" | "other" | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type !== "IfStatement" && a.type !== "ConditionalExpression") continue;
    const test = a.test ? sourceTextOf(a.test, content) : "";
    if (/NODE_ENV\s*===\s*['"]development['"]/.test(test)) return "dev";
    if (/NODE_ENV\s*!==\s*['"]production['"]/.test(test)) return "dev";
    if (/'development'\s*===\s*.*NODE_ENV/.test(test)) return "dev";
    if (/NODE_ENV\s*===\s*['"]production['"]/.test(test)) return "prod";
    if (/NODE_ENV\s*!==\s*['"]development['"]/.test(test)) return "prod";
    return "other";
  }
  return null;
}

function isDebugSetCall(node: AstNode): boolean {
  if (node.type !== "CallExpression") return false;
  const name = node.callee ? readDottedName(node.callee) : null;
  if (!name) return false;
  const args = node.arguments || [];
  // app.set('debug', true) / app.set('env', 'development') / app.enable('debug')
  if (/^(?:app|server)\.set$/i.test(name) && args.length >= 2) {
    const k = args[0];
    const v = args[1];
    if (k?.type === "Literal" && typeof k.value === "string") {
      if (k.value === "debug" && v?.type === "Literal" && (v.value === true || v.value === 1)) return true;
      if (k.value === "env" && v?.type === "Literal" && v.value === "development") return true;
    }
    return false;
  }
  if (/^(?:app|server)\.enable$/i.test(name) && args.length >= 1) {
    const k = args[0];
    return k?.type === "Literal" && k.value === "debug";
  }
  return false;
}

function isDebugTrueProperty(node: AstNode): boolean {
  if (node.type !== "Property" && node.type !== "ObjectProperty") return false;
  const key = node.key?.type === "Identifier" ? node.key.name : node.key?.value;
  return key === "debug" && node.value?.type === "Literal" && node.value.value === true;
}

function isNodeEnvDevAssignment(node: AstNode): boolean {
  if (node.type !== "AssignmentExpression") return false;
  const left = node.left ? readDottedName(node.left) : null;
  return (
    left === "process.env.NODE_ENV" &&
    node.right?.type === "Literal" &&
    node.right.value === "development"
  );
}

export function probeDebugMode(files: ScanInputFile[]): PreFlightFinding[] {
  try {
    return probeDebugInner(files);
  } catch {
    // Never-throw contract: a probe failure is recorded by the caller.
    return [];
  }
}

function probeDebugInner(files: ScanInputFile[]): PreFlightFinding[] {
  const findings: PreFlightFinding[] = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
    if (isTestFile(f.path)) continue;
    const path = f.path;
    const content = f.content;

    // ---- Env files ----
    if (isEnvFile(path)) {
      if (EXCLUDED_ENV_RE.test(path)) continue;
      const isProd = PROD_ENV_RE.test(path);
      const isPlain = PLAIN_ENV_RE.test(path);
      if (!isProd && !isPlain) continue; // e.g. .env.foo — not a known env file
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const parsed = parseEnvLine(lines[i]);
        if (!parsed) continue;
        const [key, value] = parsed;
        const upper = key.toUpperCase();
        let flagged = false;
        let label = "";
        if (upper === "DEBUG") {
          const kind = debugValueKind(value);
          if (kind === "truthy" || kind === "bare") {
            flagged = true;
            label = value === null ? "DEBUG" : `DEBUG=${value}`;
          }
        } else if (upper === "NODE_ENV" && value !== null && value.toLowerCase() === "development") {
          flagged = true;
          label = `NODE_ENV=${value}`;
        }
        if (!flagged) continue;
        const lineNo = i + 1;
        if (isProd) {
          findings.push({
            severity: "high",
            probe: DEBUG_MODE_PROBE,
            title: `Debug mode enabled in ${path}`,
            file: path,
            line: lineNo,
            evidence: `${path}:${lineNo} — ${label}`,
            remediation:
              "Remove the debug flag from this production env file (or set it to false). Debug mode leaks stack traces, config, and query history into error pages, and in some frameworks serves an executable debug console.",
            owasp: ["A05"],
            cwe: "CWE-489",
          });
        } else {
          findings.push({
            severity: "high",
            probe: DEBUG_MODE_PROBE,
            title: `Debug mode enabled in ${path}`,
            file: path,
            line: lineNo,
            evidence: `${path}:${lineNo} — ${label}. The probe cannot establish whether this .env file is the one deployed to production.`,
            remediation: DEBUG_ENV_QUESTION,
            unverified: true,
            owasp: ["A05"],
            cwe: "CWE-489",
          });
        }
      }
      continue;
    }

    // ---- Code files ----
    if (!/\.[jt]sx?$/.test(path)) continue;
    // A `debug: true` property or a NODE_ENV assignment only counts in
    // a config or server-entry file; an app.set/app.enable call is
    // itself the signal of a server entry, so any file with one is
    // scanned.
    const isConfigFile = isConfigOrServerFile(path);
    const mentionsDebugCall = /app\.set|app\.enable/.test(content);
    if (!isConfigFile && !mentionsDebugCall) continue;
    const ast = parseFile(content, path);
    if (!ast) continue;
    walkWithAncestors(ast, [], (node, ancestors) => {
      const isFlag =
        isDebugSetCall(node) ||
        (isConfigFile && isNodeEnvDevAssignment(node)) ||
        (isConfigFile && isDebugTrueProperty(node));
      if (!isFlag) return;
      const line = node.loc?.start?.line ?? 1;
      const text = sourceTextOf(node, content).replace(/\s+/g, " ").trim().slice(0, 120);
      const guard = guardKind(ancestors, content);
      if (guard === "dev") return; // debug only in development — not a finding
      if (guard === "other") {
        findings.push({
          severity: "high",
          probe: DEBUG_MODE_PROBE,
          title: "Debug mode flag in server code",
          file: path,
          line,
          evidence: `${path}:${line} — ${text}. The probe cannot establish whether this flag applies in production.`,
          remediation: DEBUG_CODE_QUESTION,
          unverified: true,
          owasp: ["A05"],
          cwe: "CWE-489",
        });
        return;
      }
      findings.push({
        severity: "high",
        probe: DEBUG_MODE_PROBE,
        title: "Debug mode flag in server code",
        file: path,
        line,
        evidence: `${path}:${line} — ${text}`,
        remediation:
          "Remove the debug flag from production code (or guard it so it only applies outside production). Debug mode leaks stack traces, config, and query history into error pages, and in some frameworks serves an executable debug console.",
        owasp: ["A05"],
        cwe: "CWE-489",
      });
    });
  }
  return findings;
}
