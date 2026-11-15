// Taint-path calibration for the vendored taint engine's filesystem sink
// (server/preflight/vendor/lib/probes/taint-engine.js, sink `fs-call`,
// finalread-taint-and-dead-button-precision-spec.md Fix 1 — APPROVED).
//
// The engine fires its filesystem sink whenever ANY argument of
// fs.writeFile (etc.) is request-derived — including the CONTENT argument.
// A write of uploaded bytes to a fixed path is not a traversal: the path
// is the thing that must be user-controlled for the finding to mean
// anything. This filter drops the finding when no PATH argument of the
// sink call is request-derived (after the spec's sanitizers).
//
// Fail-closed by design: anything the filter cannot establish — unparsable
// file, sink call not found at the finding's line, ambiguous scope — keeps
// the finding. A dropped finding is one the filter positively established
// as content-only.
//
// This module never edits the vendored engine. It re-evaluates the path
// argument in first-party code, mirroring the engine's source/propagation
// semantics, with one deliberate difference: the sanitizer set also
// includes path.basename and the safeResolveWithin shape (the spec's
// rule 1), which the engine does not recognise.
import { Parser } from "acorn";
import jsx from "acorn-jsx";
import * as acornLoose from "acorn-loose";

const JsxParser = Parser.extend(jsx());

// Minimal structural type for the raw vendor findings this filter sees.
// The adapter passes its raw findings through; only these fields are read.
export interface TaintFindingLike {
  id?: unknown;
  probe?: unknown;
  title?: unknown;
  file?: unknown;
  line?: unknown;
}

const FS_CALL_TITLE = "Filesystem call built from user-controlled value (taint flow)";

// Same callee shape as the engine's fs-call sink (taint-engine.js):
// fs/fsp member calls and path.join/path.resolve.
const FS_CALL_CALLEE_RE =
  /^(?:fs|fsPromises|fsp|node:fs)\.(?:read|write|append|create(?:Read|Write)Stream|stat|lstat|access|unlink|rmdir|readdir|opendir|cp|copy)(?:File|Sync)?$/;
const PATH_CALL_RE = /^path\.(?:join|resolve)$/;

// ---------------------------------------------------------------------------
// Parsing (mirrors the engine's parseFile)
// ---------------------------------------------------------------------------

type AstNode = any;

function parseFile(content: string, ext: string): AstNode | null {
  const isJsx = /\.(?:jsx|tsx)$/.test(ext);
  try {
    return JsxParser.parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    if (isJsx) return null;
    try {
      return acornLoose.parse(content, {
        ecmaVersion: "latest",
        sourceType: "module",
        locations: true,
      });
    } catch {
      return null;
    }
  }
}

// Read a chain of MemberExpression / Identifier and return the dotted name.
// Null when computed properties interrupt the chain. (Same as the engine.)
function readDottedName(node: AstNode): string | null {
  const parts: string[] = [];
  let cur = node;
  while (
    cur &&
    (cur.type === "MemberExpression" || cur.type === "Identifier" || cur.type === "ThisExpression")
  ) {
    if (cur.type === "Identifier") {
      parts.unshift(cur.name);
      break;
    }
    if (cur.type === "ThisExpression") {
      parts.unshift("this");
      break;
    }
    if (cur.computed) return null;
    if (cur.property.type !== "Identifier") return null;
    parts.unshift(cur.property.name);
    cur = cur.object;
  }
  return parts.length ? parts.join(".") : null;
}

// ---------------------------------------------------------------------------
// Sources and sanitizers (engine semantics + the spec's rule-1 additions)
// ---------------------------------------------------------------------------

const HTTP_INPUT_RE =
  /^(?:req|request|ctx|context|event|c\.req)\.(?:body|query|params|headers|cookies|searchParams|url|originalUrl|path|baseUrl|queryStringParameters)(?:\.[A-Za-z_$][\w$]*)*$/;
const BODY_READ_RE =
  /^(?:req|request|ctx|context|event|c\.req)\.(?:json|text|formData|arrayBuffer|blob)$/;

interface TaintTag {
  source: string;
  originLine?: number;
}

// A call that neutralises path taint. The engine's own set (path.normalize,
// path.resolve with a literal first argument) plus the spec's rule 1:
// path.basename (strips directory components) and the safeResolveWithin
// shape — a base-directory resolution that asserts the result stays inside
// the base. Recognised by name (the helper's own name, or a namespaced
// spelling of it). An allowlist-of-known-filenames check is NOT recognised
// here: a value that passed one still reads as tainted, so its finding is
// kept — the safe direction, and a documented gap.
function isPathSanitizer(node: AstNode): boolean {
  if (!node || node.type !== "CallExpression") return false;
  const callee = node.callee;
  const name =
    callee?.type === "MemberExpression"
      ? readDottedName(callee)
      : callee?.type === "Identifier"
        ? callee.name
        : null;
  if (!name) return false;
  if (name === "path.normalize") return true;
  if (name === "path.basename") return true;
  const last = name.split(".").pop() || "";
  if (/^(?:safeResolveWithin|resolveWithin|safeJoin|safeResolve)$/.test(last)) return true;
  if (
    name === "path.resolve" &&
    node.arguments?.[0]?.type === "Literal" &&
    typeof node.arguments[0].value === "string"
  )
    return true;
  return false;
}

// Evaluate an expression for request-derivation in `scope`.
// Mirrors the engine's evaluateExpression, with isPathSanitizer in place
// of the engine's SANITIZERS. Returns a tag or null.
function evaluateExpression(node: AstNode, scope: Map<string, TaintTag>): TaintTag | null {
  if (!node) return null;
  if (node.type === "MemberExpression") {
    const name = readDottedName(node);
    if (name && HTTP_INPUT_RE.test(name)) {
      return { source: name, originLine: node.loc?.start?.line };
    }
    if (
      name === "document.cookie" ||
      name === "location.hash" ||
      name === "location.search" ||
      name === "location.pathname" ||
      name === "window.name"
    ) {
      return { source: name, originLine: node.loc?.start?.line };
    }
    return evaluateExpression(node.object, scope);
  }
  if (node.type === "CallExpression" && node.callee?.type === "MemberExpression") {
    const name = readDottedName(node.callee);
    if (
      name === "localStorage.getItem" ||
      name === "sessionStorage.getItem"
    ) {
      return { source: name, originLine: node.loc?.start?.line };
    }
  }
  if (node.type === "Identifier") {
    return scope.get(node.name) || null;
  }
  if (node.type === "ThisExpression") return null;
  if (node.type === "CallExpression") {
    if (isPathSanitizer(node)) return null;
    if (node.callee?.type === "MemberExpression") {
      const name = readDottedName(node.callee);
      if (name && BODY_READ_RE.test(name)) {
        return { source: name + "()", originLine: node.loc?.start?.line };
      }
      const recvTaint = evaluateExpression(node.callee.object, scope);
      if (recvTaint) return recvTaint;
    }
    for (const arg of node.arguments || []) {
      const t = evaluateExpression(arg, scope);
      if (t) return t;
    }
    return null;
  }
  if (node.type === "TemplateLiteral") {
    for (const ex of node.expressions || []) {
      const t = evaluateExpression(ex, scope);
      if (t) return t;
    }
    return null;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return evaluateExpression(node.left, scope) || evaluateExpression(node.right, scope);
  }
  if (node.type === "LogicalExpression") {
    return evaluateExpression(node.left, scope) || evaluateExpression(node.right, scope);
  }
  if (node.type === "ConditionalExpression") {
    return evaluateExpression(node.consequent, scope) || evaluateExpression(node.alternate, scope);
  }
  if (node.type === "AwaitExpression") {
    return evaluateExpression(node.argument, scope);
  }
  if (node.type === "SequenceExpression") {
    const exprs = node.expressions || [];
    return evaluateExpression(exprs[exprs.length - 1], scope);
  }
  return null;
}

// Every binding name introduced by a destructuring pattern.
function patternNames(pattern: AstNode, out: string[] = []): string[] {
  if (!pattern || typeof pattern !== "object") return out;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties || []) {
        if (prop.type === "RestElement") patternNames(prop.argument, out);
        else patternNames(prop.value ?? prop.argument, out);
      }
      break;
    case "ArrayPattern":
      for (const el of pattern.elements || []) if (el) patternNames(el, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    default:
      break;
  }
  return out;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

// Find the innermost function node containing `line`, or null for module
// scope. The sink call itself is found separately; this only locates the
// scope its identifiers live in.
function findEnclosingFunction(ast: AstNode, line: number): AstNode | null {
  let best: AstNode | null = null;
  const visit = (node: AstNode) => {
    if (!node || typeof node !== "object") return;
    if (FUNCTION_TYPES.has(node.type)) {
      const start = node.loc?.start?.line;
      const end = node.loc?.end?.line;
      if (typeof start === "number" && typeof end === "number" && line >= start && line <= end) {
        if (!best || (best.loc && node.loc && node.loc.start.line >= best.loc.start.line)) {
          best = node;
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
      const val = node[key];
      if (Array.isArray(val)) val.forEach(visit);
      else if (val && typeof val === "object") visit(val);
    }
  };
  visit(ast);
  return best;
}

// Build the identifier→taint scope for the function containing the sink,
// as of the sink call: bindings are tracked in traversal order and the
// walk stops at the sink call node itself, mirroring the engine (a binding
// defined after the call is not in scope when the call is checked).
function buildScope(fn: AstNode | null, sinkCall: AstNode): Map<string, TaintTag> {
  const scope = new Map<string, TaintTag>();
  if (!fn) return scope;
  for (const p of fn.params || []) {
    if (p.type === "Identifier" && /^(?:req|request|ctx|event)$/.test(p.name)) {
      scope.set(p.name, { source: p.name, originLine: p.loc?.start?.line });
    }
  }
  let stopped = false;
  const walk = (node: AstNode) => {
    if (!node || typeof node !== "object" || stopped) return;
    if (node === sinkCall) {
      stopped = true;
      return;
    }
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations || []) {
        if (!d.init) continue;
        if (d.id?.type === "Identifier") {
          const t = evaluateExpression(d.init, scope);
          if (t) scope.set(d.id.name, t);
          else scope.delete(d.id.name);
        } else if (d.id?.type === "ObjectPattern" || d.id?.type === "ArrayPattern") {
          const t = evaluateExpression(d.init, scope);
          if (t) for (const name of patternNames(d.id)) scope.set(name, t);
        }
      }
    } else if (node.type === "AssignmentExpression") {
      if (node.left?.type === "Identifier") {
        const t = evaluateExpression(node.right, scope);
        if (t) scope.set(node.left.name, t);
        else scope.delete(node.left.name);
      }
    }
    for (const key of Object.keys(node)) {
      if (stopped) return;
      if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const child of val) {
          if (stopped) return;
          if (child && FUNCTION_TYPES.has(child.type)) continue;
          walk(child);
        }
      } else if (val && typeof val === "object") {
        if (FUNCTION_TYPES.has(val.type)) continue;
        walk(val);
      }
    }
  };
  walk(fn.body);
  return scope;
}

// Find the fs-call sink CallExpression starting at `line`, or null.
function findSinkCall(ast: AstNode, line: number): AstNode | null {
  let found: AstNode | null = null;
  const visit = (node: AstNode) => {
    if (!node || typeof node !== "object" || found) return;
    if (
      node.type === "CallExpression" &&
      node.loc?.start?.line === line &&
      node.callee?.type === "MemberExpression"
    ) {
      const name = readDottedName(node.callee);
      if (name && (FS_CALL_CALLEE_RE.test(name) || PATH_CALL_RE.test(name))) {
        found = node;
        return;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
      const val = node[key];
      if (Array.isArray(val)) val.forEach(visit);
      else if (val && typeof val === "object") visit(val);
    }
  };
  visit(ast);
  return found;
}

// Which argument indexes of the sink call are path arguments? For fs.*
// calls the path is argument 0; for path.join/resolve every argument is a
// path segment.
function pathArgIndexes(calleeName: string, argCount: number): number[] {
  if (PATH_CALL_RE.test(calleeName)) {
    return Array.from({ length: argCount }, (_, i) => i);
  }
  return argCount > 0 ? [0] : [];
}

// True when the finding is content-only: no path argument of its sink call
// is request-derived. Fail-closed — any uncertainty returns false (keep).
export function isContentOnlyTaintFinding(
  finding: TaintFindingLike,
  content: string | undefined
): boolean {
  if (typeof finding.line !== "number" || typeof finding.file !== "string") return false;
  if (!content) return false;
  const ext = finding.file.match(/\.[jt]sx?$/)?.[0] || ".js";
  const ast = parseFile(content, ext);
  if (!ast) return false;
  const sinkCall = findSinkCall(ast, finding.line);
  if (!sinkCall) return false;
  const calleeName = readDottedName(sinkCall.callee);
  if (!calleeName) return false;
  const fn = findEnclosingFunction(ast, finding.line);
  const scope = buildScope(fn, sinkCall);
  const args = sinkCall.arguments || [];
  for (const idx of pathArgIndexes(calleeName, args.length)) {
    if (evaluateExpression(args[idx], scope)) return false;
  }
  return true;
}

// Drop fs-call taint findings whose sink call's path is not
// request-derived. Every other finding passes through untouched.
export function dropContentOnlyTaintFindings<T extends TaintFindingLike>(
  findings: T[],
  files: Map<string, string>
): T[] {
  return findings.filter((f) => {
    const isFsCall =
      (typeof f.id === "string" && f.id.startsWith("taint-fs-call-")) ||
      (f.probe === "Taint Flow" && f.title === FS_CALL_TITLE);
    if (!isFsCall) return true;
    if (typeof f.file !== "string") return true;
    return !isContentOnlyTaintFinding(f, files.get(f.file));
  });
}
