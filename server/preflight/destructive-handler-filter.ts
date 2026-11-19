// First-party calibration for the vendored "Destructive HTTP handler
// (DELETE/PUT/PATCH) without auth check" probe
// (server/preflight/vendor/lib/probes/auth.js, probe "API Route Auth",
// finalread-detector-precision-fix-spec.md Item 1 — APPROVED).
//
// The probe's `hasDestructiveVerb` fires on ANY database write
// (auth.js:1693, the "ORM/DB call signal" regex), regardless of the
// exported HTTP method, and the per-route check that does verify the
// method (auth.js:1734) only runs for Express-like files — so a Next.js
// route.ts that exports only POST/GET and writes to the database gets
// titled "(DELETE/PUT/PATCH)". The probe's `hasAuth` also does not
// recognise a Bearer-token check done with `timingSafeEqual`, so a
// genuinely auth-gated route reads as unauthenticated.
//
// This filter re-examines each such finding against the source, in order:
//   1. Bearer-token auth gate (Authorization header compared with
//      timingSafeEqual, or an equivalent constant-time compare against
//      an env-held key) that is actually reachable from a handler
//      → the "without auth check" claim is false → DROP.
//   2. The file exports DELETE, PUT, or PATCH → KEEP as-is.
//   3. The file exports only POST/GET (or no method) and performs a
//      database mutation without a recognised auth gate → RE-TITLE to
//      name the actual exported method and the mutation. Severity,
//      evidence and remediation (adjusted to the actual method) are kept.
//   4. The exported method cannot be determined (dynamic/aliased export)
//      → unverified: true, with the specific verification question in
//      remediation.
//
// Fail-closed: anything the filter cannot establish keeps the finding
// (step 4 routes it to verification); it never silently drops. The
// vendored probe is untouched — this is first-party, following the
// taint-path-filter.ts model.
import {
  parseFile,
  readDottedName,
  walkAst,
  findEnclosingFunction,
  FUNCTION_TYPES,
  type AstNode,
} from "./ast-util";

// Minimal structural type for the raw vendor findings this filter sees.
export interface DestructiveFindingLike {
  id?: unknown;
  probe?: unknown;
  title?: unknown;
  file?: unknown;
  line?: unknown;
  severity?: unknown;
  evidence?: unknown;
  remediation?: unknown;
  unverified?: unknown;
}

const DESTRUCTIVE_ID_PREFIX = "api-destructive-";
const DESTRUCTIVE_TITLE = "Destructive HTTP handler (DELETE/PUT/PATCH) without auth check";

export const DESTRUCTIVE_METHOD_QUESTION =
  "Does this file export a DELETE, PUT, or PATCH handler, or only POST/GET? Point at the export that settles it.";

// Exported HTTP methods: `export async function POST` and
// `export const POST = ...` (both Next.js App Router shapes).
const METHOD_EXPORT_RE =
  /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|DELETE|PATCH)\b/g;
// Express / Fastify / Hono route registrations.
const ROUTE_REGISTER_RE =
  /\b(?:app|router|fastify|hono?)\s*\.\s*(get|post|put|patch|delete)\s*\(/gi;
// The vendored probe's DB-call signal (auth.js:1693), plus the write
// verbs Drizzle / Mongoose / Prisma use that the probe's own regex also
// reaches through its `\w*` suffix.
const DB_MUTATION_RE = /\.(?:delete|update|create|remove|insert|upsert|set|save)\w*\s*\(/;
// Dynamic / aliased exports the filter cannot resolve statically.
const DYNAMIC_EXPORT_RE =
  /export\s*\{[^}]*\b(?:DELETE|PUT|PATCH|GET|POST)\b|module\.exports\s*=|\b(?:app|router)\s*\[/;

// A constant-time token comparison: timingSafeEqual and its equivalents.
const CONSTANT_TIME_COMPARE_RE =
  /(?:^|\.)(?:timingSafeEqual|timingSafeCompare|safeCompare|secureCompare|constantTimeEqual)$/i;

// ---------------------------------------------------------------------------
// Exported-method detection (regex, mirroring the vendored probe)
// ---------------------------------------------------------------------------

function exportedMethods(content: string): Set<string> {
  const methods = new Set<string>();
  for (const m of content.matchAll(METHOD_EXPORT_RE)) methods.add(m[1]);
  for (const m of content.matchAll(ROUTE_REGISTER_RE)) methods.add(m[1].toUpperCase());
  return methods;
}

function hasDbMutation(content: string): boolean {
  return DB_MUTATION_RE.test(content);
}

function hasDynamicExport(content: string): boolean {
  return DYNAMIC_EXPORT_RE.test(content);
}

// ---------------------------------------------------------------------------
// Bearer + constant-time-comparison auth gate (AST)
// ---------------------------------------------------------------------------

// An Authorization header read in any of its common shapes.
function isHeaderRead(node: AstNode): boolean {
  if (!node || typeof node !== "object") return false;
  // req.headers.get('authorization') / headers.get("Authorization")
  if (node.type === "CallExpression") {
    const calleeName = node.callee ? readDottedName(node.callee) : null;
    if (
      calleeName &&
      (calleeName === "headers.get" || calleeName.endsWith(".headers.get"))
    ) {
      const arg0 = node.arguments?.[0];
      return (
        arg0?.type === "Literal" &&
        typeof arg0.value === "string" &&
        arg0.value.toLowerCase() === "authorization"
      );
    }
    return false;
  }
  // req.headers.authorization
  if (node.type === "MemberExpression" && !node.computed) {
    const name = readDottedName(node);
    return (
      !!name &&
      /^(?:req|request|ctx|context|event|headers)\.headers\.authorization$/i.test(name)
    );
  }
  // req.headers['authorization']
  if (node.type === "MemberExpression" && node.computed) {
    const objName = node.object ? readDottedName(node.object) : null;
    const prop = node.property;
    return (
      !!objName &&
      /(?:^|\.)headers$/i.test(objName) &&
      prop?.type === "Literal" &&
      typeof prop.value === "string" &&
      prop.value.toLowerCase() === "authorization"
    );
  }
  return false;
}

function isEnvRead(node: AstNode): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.type === "MemberExpression" && !node.computed) {
    const name = readDottedName(node);
    return (
      !!name &&
      /^(?:process\.env|import\.meta\.env|Bun\.env)\./.test(name)
    );
  }
  return false;
}

// Bindings in the enclosing function, as of the gate call: identifier ->
// init expression. A destructured `authorization` taken from a `.headers`
// object maps to the marker "header-read" so the provenance check sees it.
type Binding = AstNode | "header-read" | "env-read";

function buildBindingMap(fn: AstNode, stopNode: AstNode): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  let stopped = false;
  const record = (pattern: AstNode, init: AstNode | null) => {
    if (!pattern || !init) return;
    if (pattern.type === "Identifier") {
      bindings.set(pattern.name, init);
      return;
    }
    if (pattern.type === "ObjectPattern") {
      const initName = readDottedName(init);
      for (const prop of pattern.properties || []) {
        if (prop.type !== "Property" && prop.type !== "ObjectProperty") continue;
        const key = prop.key?.type === "Identifier" ? prop.key.name : prop.key?.value;
        if (typeof key !== "string") continue;
        if (
          key.toLowerCase() === "authorization" &&
          initName &&
          /(?:^|\.)headers$/.test(initName)
        ) {
          bindings.set(
            prop.value?.type === "Identifier" ? prop.value.name : key,
            "header-read"
          );
        } else if (prop.value?.type === "Identifier") {
          bindings.set(prop.value.name, init);
        }
      }
      return;
    }
    if (pattern.type === "ArrayPattern") {
      for (const el of pattern.elements || []) {
        if (el?.type === "Identifier") bindings.set(el.name, init);
      }
    }
  };
  const walk = (node: AstNode) => {
    if (!node || typeof node !== "object" || stopped) return;
    if (node === stopNode) {
      stopped = true;
      return;
    }
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations || []) record(d.id, d.init ?? null);
    } else if (node.type === "AssignmentExpression" && node.left?.type === "Identifier") {
      bindings.set(node.left.name, node.right);
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
  if (fn?.body) walk(fn.body);
  return bindings;
}

// True when `expr` is, or derives from, an Authorization header read.
// `seen` guards against circular bindings (a -> b -> a).
function isHeaderDerived(
  expr: AstNode,
  bindings: Map<string, Binding>,
  seen: Set<string> = new Set()
): boolean {
  if (!expr || typeof expr !== "object") return false;
  if (expr === "header-read") return true;
  if (isHeaderRead(expr)) return true;
  if (expr.type === "Identifier") {
    if (seen.has(expr.name)) return false;
    seen.add(expr.name);
    const b = bindings.get(expr.name);
    if (b === "header-read") return true;
    if (b === "env-read") return false;
    return b ? isHeaderDerived(b, bindings, seen) : false;
  }
  if (expr.type === "MemberExpression") return isHeaderDerived(expr.object, bindings, seen);
  if (expr.type === "CallExpression") {
    if (expr.callee?.type === "MemberExpression" && isHeaderDerived(expr.callee.object, bindings, seen))
      return true;
    for (const arg of expr.arguments || []) if (isHeaderDerived(arg, bindings, seen)) return true;
    return false;
  }
  if (expr.type === "AwaitExpression") return isHeaderDerived(expr.argument, bindings, seen);
  if (expr.type === "ConditionalExpression")
    return (
      isHeaderDerived(expr.consequent, bindings, seen) || isHeaderDerived(expr.alternate, bindings, seen)
    );
  if (expr.type === "LogicalExpression")
    return isHeaderDerived(expr.left, bindings, seen) || isHeaderDerived(expr.right, bindings, seen);
  if (expr.type === "TemplateLiteral") {
    for (const ex of expr.expressions || []) if (isHeaderDerived(ex, bindings, seen)) return true;
    return false;
  }
  if (expr.type === "BinaryExpression")
    return isHeaderDerived(expr.left, bindings, seen) || isHeaderDerived(expr.right, bindings, seen);
  return false;
}

// True when `expr` is, or derives from, an environment variable read.
// `seen` guards against circular bindings (a -> b -> a).
function isEnvDerived(
  expr: AstNode,
  bindings: Map<string, Binding>,
  seen: Set<string> = new Set()
): boolean {
  if (!expr || typeof expr !== "object") return false;
  if (expr === "env-read") return true;
  if (isEnvRead(expr)) return true;
  if (expr.type === "Identifier") {
    if (seen.has(expr.name)) return false;
    seen.add(expr.name);
    const b = bindings.get(expr.name);
    if (b === "env-read") return true;
    if (b === "header-read") return false;
    return b ? isEnvDerived(b, bindings, seen) : false;
  }
  if (expr.type === "MemberExpression") return isEnvDerived(expr.object, bindings, seen);
  if (expr.type === "CallExpression") {
    if (expr.callee?.type === "MemberExpression" && isEnvDerived(expr.callee.object, bindings, seen))
      return true;
    for (const arg of expr.arguments || []) if (isEnvDerived(arg, bindings, seen)) return true;
    return false;
  }
  if (expr.type === "AwaitExpression") return isEnvDerived(expr.argument, bindings, seen);
  if (expr.type === "ConditionalExpression")
    return isEnvDerived(expr.consequent, bindings, seen) || isEnvDerived(expr.alternate, bindings, seen);
  if (expr.type === "LogicalExpression")
    return isEnvDerived(expr.left, bindings, seen) || isEnvDerived(expr.right, bindings, seen);
  if (expr.type === "TemplateLiteral") {
    for (const ex of expr.expressions || []) if (isEnvDerived(ex, bindings, seen)) return true;
    return false;
  }
  if (expr.type === "BinaryExpression")
    return isEnvDerived(expr.left, bindings, seen) || isEnvDerived(expr.right, bindings, seen);
  return false;
}

// The name a function node goes by in this file, if it has one.
function functionNodeName(fn: AstNode, ast: AstNode): string | null {
  if (fn?.type === "FunctionDeclaration" && fn.id?.type === "Identifier") return fn.id.name;
  // Assigned to a variable / property: find the declarator.
  let found: string | null = null;
  walkAst(ast, (node) => {
    if (found) return false;
    if (
      node.type === "VariableDeclarator" &&
      node.init === fn &&
      node.id?.type === "Identifier"
    ) {
      found = node.id.name;
      return false;
    }
    if (
      (node.type === "Property" || node.type === "ObjectProperty") &&
      node.value === fn &&
      node.key?.type === "Identifier"
    ) {
      found = node.key.name;
      return false;
    }
    if (
      node.type === "AssignmentExpression" &&
      node.right === fn &&
      node.left?.type === "Identifier"
    ) {
      found = node.left.name;
      return false;
    }
  });
  return found;
}

// Function nodes that are HTTP handlers in this file: Next.js method
// exports and functions passed as route-registration arguments.
function collectHandlerFunctions(ast: AstNode): Set<AstNode> {
  const handlers = new Set<AstNode>();
  walkAst(ast, (node) => {
    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      const d = node.declaration;
      if (d.type === "FunctionDeclaration") handlers.add(d);
      if (d.type === "VariableDeclaration") {
        for (const decl of d.declarations || []) {
          if (decl.init && FUNCTION_TYPES.has(decl.init.type)) handlers.add(decl.init);
        }
      }
    }
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression") {
      const name = readDottedName(node.callee);
      if (
        name &&
        /^(?:app|router|fastify|hono?)\.(?:get|post|put|patch|delete)$/i.test(name)
      ) {
        for (const arg of node.arguments || []) {
          if (FUNCTION_TYPES.has(arg.type)) handlers.add(arg);
        }
      }
    }
  });
  return handlers;
}

// Call graph: function name -> names it calls or passes as an argument.
// Used to tell a live auth helper from one that is defined but never used.
function buildCallGraph(ast: AstNode, knownNames: Set<string>): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  // Map each function node to its name, so calls inside it are attributed.
  const fnNameByNode = new Map<AstNode, string>();
  walkAst(ast, (node) => {
    if (FUNCTION_TYPES.has(node.type)) {
      const name = functionNodeName(node, ast);
      if (name) fnNameByNode.set(node, name);
    }
  });
  walkAst(ast, (node) => {
    if (!FUNCTION_TYPES.has(node.type)) return;
    const name = fnNameByNode.get(node);
    if (!name) return;
    const called = graph.get(name) ?? new Set<string>();
    walkAst(node.body ?? node, (inner) => {
      if (inner !== node && FUNCTION_TYPES.has(inner.type)) return false;
      if (inner.type === "CallExpression") {
        if (inner.callee?.type === "Identifier" && knownNames.has(inner.callee.name)) {
          called.add(inner.callee.name);
        }
        for (const arg of inner.arguments || []) {
          if (arg?.type === "Identifier" && knownNames.has(arg.name)) called.add(arg.name);
        }
      }
      if (inner.type === "Identifier" && knownNames.has(inner.name)) {
        // A bare reference (middleware passed by name, handler assigned).
        called.add(inner.name);
      }
    });
    graph.set(name, called);
  });
  return graph;
}

// The gate is effective when the function holding the constant-time
// comparison is an HTTP handler, or is reachable from one (a helper the
// handler calls, or middleware the route passes). A helper that is
// defined but never used is dead code, not a gate.
function isGateEffective(ast: AstNode, gateFn: AstNode | null): boolean {
  if (!gateFn) return false;
  const handlers = collectHandlerFunctions(ast);
  if (handlers.has(gateFn)) return true;
  const knownNames = new Set<string>();
  walkAst(ast, (node) => {
    if (FUNCTION_TYPES.has(node.type)) {
      const name = functionNodeName(node, ast);
      if (name) knownNames.add(name);
    }
  });
  const gateName = functionNodeName(gateFn, ast);
  if (!gateName) return false;
  // Seed: the names of the handler functions.
  const seeds = new Set<string>();
  for (const h of handlers) {
    const n = functionNodeName(h, ast);
    if (n) seeds.add(n);
  }
  const graph = buildCallGraph(ast, knownNames);
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of graph.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.has(gateName);
}

// True when the file contains a Bearer-token auth gate the vendored probe
// does not recognise, and that gate is actually reachable from a handler.
function hasEffectiveBearerGate(content: string, ext: string): boolean {
  const ast = parseFile(content, ext);
  if (!ast) return false;
  let effective = false;
  walkAst(ast, (node) => {
    if (effective) return false;
    if (node.type !== "CallExpression") return;
    const calleeName = node.callee ? readDottedName(node.callee) : null;
    if (!calleeName || !CONSTANT_TIME_COMPARE_RE.test(calleeName)) return;
    const args = node.arguments || [];
    if (args.length < 2) return;
    const line = node.loc?.start?.line;
    if (typeof line !== "number") return;
    const fn = findEnclosingFunction(ast, line);
    const bindings = buildBindingMap(fn, node);
    const headerFirst =
      isHeaderDerived(args[0], bindings) && isEnvDerived(args[1], bindings);
    const envFirst =
      isEnvDerived(args[0], bindings) && isHeaderDerived(args[1], bindings);
    if (headerFirst || envFirst) {
      if (isGateEffective(ast, fn)) effective = true;
    }
  });
  return effective;
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

function retitle(
  method: string | null,
  remediation: string
): { title: string; remediation: string } {
  const label = method ? `${method} handler` : "Database mutation";
  const title = `${label} performs database mutation without auth check`;
  const prefix = method
    ? `This ${method} handler performs a database mutation without an auth check. `
    : `This file performs a database mutation without an auth check. `;
  return {
    title,
    remediation: remediation ? prefix + remediation : prefix.trim(),
  };
}

export function calibrateDestructiveHandlerFindings<T extends DestructiveFindingLike>(
  findings: T[],
  files: Map<string, string>
): T[] {
  const out: T[] = [];
  for (const f of findings) {
    const isDestructive =
      (typeof f.id === "string" && f.id.startsWith(DESTRUCTIVE_ID_PREFIX)) ||
      (typeof f.title === "string" && f.title.startsWith(DESTRUCTIVE_TITLE));
    if (!isDestructive) {
      out.push(f);
      continue;
    }
    const file = typeof f.file === "string" ? f.file : "";
    const content = files.get(file);
    // No source to re-examine: keep the finding. Fail-closed.
    if (content === undefined) {
      out.push(f);
      continue;
    }
    const ext = file.match(/\.[jt]sx?$/)?.[0] || ".js";

    // Step 1 — Bearer-token auth gate, reachable from a handler.
    if (hasEffectiveBearerGate(content, ext)) continue; // DROP

    const methods = exportedMethods(content);

    // Step 2 — a real DELETE / PUT / PATCH export: keep as-is.
    if (methods.has("DELETE") || methods.has("PUT") || methods.has("PATCH")) {
      out.push(f);
      continue;
    }

    // Step 4 (before re-title) — no static method and a dynamic/aliased
    // export the filter cannot resolve: the file may export a destructive
    // method under an alias, so the method cannot be established. Route
    // to verification with the specific question.
    if (methods.size === 0 && hasDynamicExport(content)) {
      out.push({
        ...f,
        unverified: true,
        remediation: DESTRUCTIVE_METHOD_QUESTION,
      });
      continue;
    }

    // Step 3 — only POST/GET (or no method) with a database mutation:
    // the label is wrong but the mutation is real. Re-title.
    if (hasDbMutation(content)) {
      const method = methods.has("POST") ? "POST" : methods.has("GET") ? "GET" : null;
      const { title, remediation } = retitle(method, String(f.remediation || ""));
      out.push({ ...f, title, remediation });
      continue;
    }

    // Cannot corroborate the mutation either: keep the finding as-is.
    out.push(f);
  }
  return out;
}
