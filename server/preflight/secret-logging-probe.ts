// First-party probe: logging secrets (finalread-gap-detectors-spec.md Item 4).
//
// A log call that writes a secret, credential, or full request body to a
// log. A log call is console.log/warn/error/info/debug, logger.info/
// warn/error/debug, or a logger-library call (winston, pino, bunyan,
// log.info, req.log, etc.). It is a finding when an argument is a
// secret-named value passed as a VALUE (not a string-literal label), the
// full request/response, or an object literal with a secret-named key and
// a non-literal value.
//
// AST, not regex — the distinction that matters (a secret *value* versus
// a secret *label*) is structural: console.log("password reset
// requested") is a string-literal label (not a finding);
// console.log("password:", password) passes `password` as a value (a
// finding).
//
// Precision only (Richard, standing): a redacted/masked value is not a
// finding; a bare `key` alone is not enough to flag; a value the probe
// cannot resolve (an imported variable, a function parameter that might
// hold a secret) routes to "Needs developer verification" (unverified:
// true + the specific question in remediation), never silently drops and
// never asserts a leak it cannot see. The vendored engine and the
// "Security Logging" probe (which flags *missing* logging, not secrets
// *in* log calls) are untouched.
import {
  parseFile,
  readDottedName,
  walkAst,
  findEnclosingFunction,
  sourceTextOf,
  patternNames,
  FUNCTION_TYPES,
  type AstNode,
} from "./ast-util";
import { isTestFile } from "./vendor/lib/file-filter.js";
import type { PreFlightFinding } from "../../shared/preflight-types";
import type { ScanInputFile } from "../preflight-scan";

export const SECRET_LOGGING_PROBE = "Secret Logging";

export const SECRET_LOGGING_QUESTION =
  "Does the logged value contain a secret, credential, or full request body? Point at the value's definition that settles it.";

// Credential-shaped names. A bare `key` or `token` alone is NOT in this
// list (a dictionary/cache key, a CSRF or pagination token) — those are
// handled as verification cases, not findings.
const STRONG_SECRET_RES = [
  /password/i,
  /passwd/i,
  /pwd/i,
  /secret/i,
  /api[\s_-]?key/i,
  /auth[\s_-]?token/i,
  /access[\s_-]?token/i,
  /refresh[\s_-]?token/i,
  /private[\s_-]?key/i,
  /credential/i,
  /session[\s_-]?token/i,
  /bearer/i,
  /client[\s_-]?secret/i,
];

function isStrongSecretName(name: string): boolean {
  return STRONG_SECRET_RES.some((re) => re.test(name));
}

// Names that might hold a secret when the probe cannot resolve the
// variable's value (a function parameter, an import). A clearly-safe
// name (userId, count) is clean, not verification.
const CONTAINER_NAME_RE =
  /^(data|payload|body|result|response|user|account|session|record|row|object|obj|details|info|input|state|config|context|ctx|event|profile|auth|credentials?)$/i;

// Masking / redaction calls: the value is not logged in the clear.
const MASK_CALL_RE =
  /^(?:.*\.)?(mask|redact|sanitize|obfuscate|hash|slice|substring|substr)$/i;

const LOG_METHODS = new Set(["log", "info", "warn", "error", "debug", "trace"]);

function isLogCall(node: AstNode): boolean {
  if (node.type !== "CallExpression") return false;
  const name = node.callee ? readDottedName(node.callee) : null;
  if (!name) return false;
  const parts = name.split(".");
  const method = parts[parts.length - 1];
  if (!LOG_METHODS.has(method)) return false;
  const obj = parts.slice(0, -1).join(".");
  if (obj === "console") return true;
  if (/^(logger|log|winston|pino|bunyan)$/i.test(obj)) return true;
  if (/\.(log|logger)$/i.test(obj)) return true; // req.log, fastify.log, this.logger
  return false;
}

// Bindings in scope for a log call: name -> init node | "param" | "import"
// | "unresolvable". Function parameters and imports are unresolvable to
// a value (the value comes from the caller / another file).
type Binding = AstNode | "param" | "import" | "unresolvable";

function buildBindings(ast: AstNode, fn: AstNode | null): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  // Imports.
  walkAst(ast, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const spec of node.specifiers || []) {
        if (spec.local?.type === "Identifier") bindings.set(spec.local.name, "import");
      }
    }
    if (node.type === "ImportExpression") return;
  });
  // Module-scope declarations. A destructured name (const { data } =
  // req.body) is recorded as unresolvable — the value's content cannot
  // be established from the pattern alone (a secret-named destructured
  // name is still caught by the name check in classifyValue).
  for (const stmt of ast.body || []) {
    if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations || []) {
        if (d.id?.type === "Identifier") {
          bindings.set(d.id.name, d.init ?? "unresolvable");
        } else {
          for (const name of patternNames(d.id)) bindings.set(name, "unresolvable");
        }
      }
    }
    if (stmt.type === "FunctionDeclaration" && stmt.id?.name) {
      bindings.set(stmt.id.name, stmt);
    }
  }
  // The enclosing function's parameters and locals (shadow the module).
  if (fn) {
    for (const p of fn.params || []) {
      if (p.type === "Identifier") bindings.set(p.name, "param");
      else if (p.type === "AssignmentPattern" && p.left?.type === "Identifier") {
        bindings.set(p.left.name, "param");
      } else if (p.type === "ObjectPattern") {
        for (const prop of p.properties || []) {
          if (prop.value?.type === "Identifier") bindings.set(prop.value.name, "param");
        }
      }
    }
    walkAst(fn.body ?? fn, (node) => {
      if (node !== fn && FUNCTION_TYPES.has(node.type)) return false;
      if (node.type === "VariableDeclaration") {
        for (const d of node.declarations || []) {
          if (d.id?.type === "Identifier") bindings.set(d.id.name, d.init ?? "unresolvable");
          else for (const name of patternNames(d.id)) bindings.set(name, "unresolvable");
        }
      }
    });
  }
  return bindings;
}

type Verdict =
  | { kind: "finding"; detail: string }
  | { kind: "verification"; detail: string }
  | { kind: "clean" };

const CLEAN: Verdict = { kind: "clean" };

function classifyValue(node: AstNode, bindings: Map<string, Binding>, depth = 0): Verdict {
  if (!node || typeof node !== "object" || depth > 4) return CLEAN;
  switch (node.type) {
    case "Literal":
      return CLEAN; // a string label, not a value
    case "TemplateLiteral": {
      for (const ex of node.expressions || []) {
        const v = classifyValue(ex, bindings, depth + 1);
        if (v.kind !== "clean") return v;
      }
      return CLEAN;
    }
    case "BinaryExpression": {
      if (node.operator === "+") {
        for (const side of [node.left, node.right]) {
          const v = classifyValue(side, bindings, depth + 1);
          if (v.kind !== "clean") return v;
        }
      }
      return CLEAN;
    }
    case "CallExpression": {
      const calleeName = node.callee ? readDottedName(node.callee) : null;
      if (calleeName && MASK_CALL_RE.test(calleeName)) return CLEAN; // masked / redacted
      // Otherwise recurse into the arguments (e.g. JSON.stringify(req.body)).
      for (const arg of node.arguments || []) {
        const v = classifyValue(arg, bindings, depth + 1);
        if (v.kind !== "clean") return v;
      }
      return CLEAN;
    }
    case "Identifier": {
      const name = node.name;
      if (isStrongSecretName(name)) return { kind: "finding", detail: `the ${name} value` };
      if (/^(req|request|res|response)$/i.test(name)) {
        return { kind: "finding", detail: "the full request/response" };
      }
      if (/^token$/i.test(name) || /^key$/i.test(name)) {
        return { kind: "verification", detail: name };
      }
      const b = bindings.get(name);
      if (b === "param" || b === "import" || b === "unresolvable") {
        return CONTAINER_NAME_RE.test(name)
          ? { kind: "verification", detail: name }
          : CLEAN;
      }
      if (b && typeof b === "object") return classifyValue(b, bindings, depth + 1);
      return CLEAN;
    }
    case "MemberExpression": {
      const full = readDottedName(node);
      if (full && /^(?:req|request)\.(?:body|headers)$/i.test(full)) {
        return { kind: "finding", detail: "the full request body/headers" };
      }
      if (full === "process.env") {
        return { kind: "finding", detail: "the full environment (process.env)" };
      }
      const propName =
        !node.computed && node.property?.type === "Identifier"
          ? node.property.name
          : node.computed && node.property?.type === "Literal"
            ? String(node.property.value)
            : null;
      if (propName) {
        if (isStrongSecretName(propName)) {
          return { kind: "finding", detail: `the ${propName} value` };
        }
        if (propName === "token") return { kind: "finding", detail: "the token value" };
        if (propName === "key") return { kind: "verification", detail: propName };
      }
      // A member access on a secret-named object that is not the secret
      // itself (e.g. password.length) logs a derived value, not the secret.
      const objName = node.object?.type === "Identifier" ? node.object.name : null;
      if (objName && isStrongSecretName(objName)) return CLEAN;
      return CLEAN;
    }
    case "ObjectExpression": {
      for (const prop of node.properties || []) {
        if (prop.type === "SpreadElement") {
          const v = classifyValue(prop.argument, bindings, depth + 1);
          if (v.kind !== "clean") return v;
          continue;
        }
        const key =
          prop.key?.type === "Identifier"
            ? prop.key.name
            : prop.key?.type === "Literal"
              ? String(prop.key.value)
              : null;
        const val = prop.value;
        if (!key || !val) continue;
        if (isStrongSecretName(key)) {
          if (val.type !== "Literal") return { kind: "finding", detail: `the ${key} value` };
          continue;
        }
        if (key === "token") {
          if (val.type !== "Literal") return { kind: "finding", detail: "the token value" };
          continue;
        }
        if (key === "key") {
          if (val.type !== "Literal") return { kind: "verification", detail: key };
          continue;
        }
        const v = classifyValue(val, bindings, depth + 1);
        if (v.kind !== "clean") return v;
      }
      return CLEAN;
    }
    case "AwaitExpression":
    case "UnaryExpression":
      return classifyValue(node.argument, bindings, depth + 1);
    case "ConditionalExpression":
    case "LogicalExpression": {
      const parts =
        node.type === "ConditionalExpression"
          ? [node.consequent, node.alternate]
          : [node.left, node.right];
      for (const p of parts) {
        const v = classifyValue(p, bindings, depth + 1);
        if (v.kind !== "clean") return v;
      }
      return CLEAN;
    }
    case "ArrayExpression": {
      for (const el of node.elements || []) {
        if (!el) continue;
        const v = classifyValue(el, bindings, depth + 1);
        if (v.kind !== "clean") return v;
      }
      return CLEAN;
    }
    default:
      return CLEAN;
  }
}

export function probeSecretLogging(files: ScanInputFile[]): PreFlightFinding[] {
  try {
    return probeSecretLoggingInner(files);
  } catch {
    // Never-throw contract: a probe failure is recorded by the caller.
    return [];
  }
}

function probeSecretLoggingInner(files: ScanInputFile[]): PreFlightFinding[] {
  const findings: PreFlightFinding[] = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
    if (isTestFile(f.path)) continue;
    if (!/\.[jt]sx?$/.test(f.path)) continue;
    // Cheap pre-filter: the file must mention a log call.
    if (!/(?:console|logger|log|winston|pino|bunyan)\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\(/.test(f.content)) {
      continue;
    }
    const ast = parseFile(f.content, f.path);
    if (!ast) continue;
    const bindingsByFn = new Map<AstNode | null, Map<string, Binding>>();
    const getBindings = (fn: AstNode | null): Map<string, Binding> => {
      let b = bindingsByFn.get(fn);
      if (!b) {
        b = buildBindings(ast, fn);
        bindingsByFn.set(fn, b);
      }
      return b;
    };
    walkAst(ast, (node) => {
      if (!isLogCall(node)) return;
      const line = node.loc?.start?.line ?? 1;
      const fn = findEnclosingFunction(ast, line);
      const bindings = getBindings(fn);
      let finding: Verdict | null = null;
      let verification: Verdict | null = null;
      for (const arg of node.arguments || []) {
        const v = classifyValue(arg, bindings);
        if (v.kind === "finding") {
          finding = v;
          break;
        }
        if (v.kind === "verification" && !verification) verification = v;
      }
      const callText = sourceTextOf(node, f.content).replace(/\s+/g, " ").trim().slice(0, 120);
      if (finding && finding.kind === "finding") {
        findings.push({
          severity: "high",
          probe: SECRET_LOGGING_PROBE,
          title: `Log call writes a secret (${finding.detail})`,
          file: f.path,
          line,
          evidence: `${f.path}:${line} — ${callText} logs ${finding.detail}`,
          remediation:
            "Remove the secret from this log call. Log only a redacted or masked value (or a request ID), and never log a password, token, API key, or full request body/headers — logs get copied, backed up, and sometimes leaked.",
          owasp: ["A09"],
          cwe: "CWE-532",
        });
      } else if (verification && verification.kind === "verification") {
        findings.push({
          severity: "high",
          probe: SECRET_LOGGING_PROBE,
          title: `Log call may write a secret (${verification.detail})`,
          file: f.path,
          line,
          evidence: `${f.path}:${line} — ${callText} logs a value the probe cannot resolve (${verification.detail}).`,
          remediation: SECRET_LOGGING_QUESTION,
          unverified: true,
          owasp: ["A09"],
          cwe: "CWE-532",
        });
      }
    });
  }
  return findings;
}
