// Shared AST helpers for the first-party post-filters (destructive-handler,
// SSRF-taint). Mirrors the parsing approach of server/preflight/taint-path-filter.ts
// (which keeps its own copies — consolidating them is a separate cleanup).
// None of this edits the vendored engine; it re-reads source files in
// first-party code.
import { Parser } from "acorn";
import jsx from "acorn-jsx";
import * as acornLoose from "acorn-loose";

const JsxParser = Parser.extend(jsx());

export type AstNode = any;

export function parseFile(content: string, ext: string): AstNode | null {
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
// Null when computed properties interrupt the chain.
export function readDottedName(node: AstNode): string | null {
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

// Source text of a node (start/end offsets). Empty string when unavailable.
export function sourceTextOf(node: AstNode, content: string): string {
  if (!node || typeof node.start !== "number" || typeof node.end !== "number") return "";
  return content.slice(node.start, node.end);
}

// Generic recursive walk. `visit` returns false to skip a subtree.
export function walkAst(node: AstNode, visit: (n: AstNode) => boolean | void): void {
  if (!node || typeof node !== "object") return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    const val = node[key];
    if (Array.isArray(val)) val.forEach((child) => walkAst(child, visit));
    else if (val && typeof val === "object") walkAst(val, visit);
  }
}

export const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

// Find the innermost function node containing `line`, or null for module scope.
export function findEnclosingFunction(ast: AstNode, line: number): AstNode | null {
  let best: AstNode | null = null;
  walkAst(ast, (node) => {
    if (FUNCTION_TYPES.has(node.type)) {
      const start = node.loc?.start?.line;
      const end = node.loc?.end?.line;
      if (typeof start === "number" && typeof end === "number" && line >= start && line <= end) {
        if (!best || (best.loc && node.loc && node.loc.start.line >= best.loc.start.line)) {
          best = node;
        }
      }
    }
  });
  return best;
}

// Every binding name introduced by a destructuring pattern.
export function patternNames(pattern: AstNode, out: string[] = []): string[] {
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

// The name a function node goes by, if it has one: a declaration name, a
// variable it is assigned to, or an object/class property key. Null for
// anonymous/inline functions.
export function functionName(node: AstNode): string | null {
  if (!node) return null;
  if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
    return node.id.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gap-detector shared helpers (finalread-gap-detectors-spec.md).
// Route collection, comment masking, import resolution, and handler-body
// inspection shared by the rate-limit, CSRF, and file-upload probes.
// None of this edits the vendored engine; it re-reads source files in
// first-party code.
// ---------------------------------------------------------------------------

// Mask // and /* */ comments with spaces, preserving line numbers so a
// regex match's line can be recovered. String literals are left intact
// (a keyword inside a string is a label, not a flag, and the probes that
// use this check shapes, not bare substrings). A regex literal containing
// "//" is the known blind spot — it masks the rest of that line, which
// loses recall, never precision.
export function stripComments(content: string): string {
  const out = content.split("");
  const n = content.length;
  let i = 0;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && content[i] !== "\n") {
        out[i] = " ";
        i++;
      }
    } else if (ch === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) {
        if (content[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (content[i] === "\\") {
          i += 2;
          continue;
        }
        if (content[i] === quote) {
          i++;
          break;
        }
        if ((quote === "'" || quote === '"') && content[i] === "\n") break;
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join("");
}

// 1-based line number for a character offset.
export function lineOf(content: string, index: number): number {
  let line = 1;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i++) if (content[i] === "\n") line++;
  return line;
}

// Resolve a relative import specifier ("./x", "../y") against the importing
// file to a workspace path, trying the usual TS/JS extension probes.
// Returns null for bare package specifiers or unresolvable paths.
// Mirrors resolveWorkspaceImport in server/deterministic-score.ts (kept
// local so the preflight probes do not import the scoring module).
export function resolveRelativeImport(
  importerPath: string,
  spec: string,
  knownPaths: Set<string>
): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = importerPath.includes("/")
    ? importerPath.slice(0, importerPath.lastIndexOf("/"))
    : "";
  const segs: string[] = [];
  for (const part of ((dir ? dir + "/" : "") + spec).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  const base = segs.join("/");
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  for (const c of candidates) if (knownPaths.has(c)) return c;
  return null;
}

// Find a function by name in an AST: a declaration, a variable-assigned
// function, or an object/class property function (including an exported
// const arrow function). Null when the name is not a function in this file.
export function findNamedFunction(ast: AstNode, name: string): AstNode | null {
  let found: AstNode | null = null;
  walkAst(ast, (node) => {
    if (found) return false;
    if (node.type === "FunctionDeclaration" && node.id?.name === name) {
      found = node;
      return false;
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.id.name === name &&
      node.init &&
      FUNCTION_TYPES.has(node.init.type)
    ) {
      found = node.init;
      return false;
    }
    if (
      (node.type === "Property" || node.type === "ObjectProperty") &&
      node.key?.type === "Identifier" &&
      node.key.name === name &&
      node.value &&
      FUNCTION_TYPES.has(node.value.type)
    ) {
      found = node.value;
      return false;
    }
    if (node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration") {
      for (const d of node.declaration.declarations || []) {
        if (
          d.id?.type === "Identifier" &&
          d.id.name === name &&
          d.init &&
          FUNCTION_TYPES.has(d.init.type)
        ) {
          found = d.init;
          return false;
        }
      }
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Route collection (shared by the rate-limit and CSRF probes)
// ---------------------------------------------------------------------------

export interface CollectedRoute {
  method: string; // uppercase, e.g. "POST"
  path: string; // "/api/auth/login" ("" when the path cannot be established)
  file: string;
  line: number; // line of the registration / export
  // Middleware identifiers and callee names in the route's chain
  // (Express-style only; Next.js routes have none).
  middlewares: string[];
  // The handler, when it is a bare identifier (resolvable via imports).
  handlerName: string | null;
  // The handler function node, when it is inline.
  handlerNode: AstNode | null;
  // False when the file did not parse and the route came from the regex
  // fallback: the handler body cannot be inspected, so a probe must not
  // assert a missing in-handler guard from it — it routes to verification.
  parsed: boolean;
  // True when the last route argument is a wrapper call (e.g.
  // asyncRoute(async (req, res) => {...})) that could not be unwrapped to
  // a handler: the handler body cannot be inspected, so a probe must not
  // assert a missing in-handler guard from it — it routes to verification.
  // Absent (undefined) when the handler was established or the route came
  // from the regex fallback (which already carries parsed: false).
  handlerUnresolved?: boolean;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Next.js App Router route file (app/**/route.ts) or Pages API file.
function nextJsRoutePath(file: string): string | null {
  const appMatch = file.match(/(?:^|\/)(?:src\/)?app\/(.+)\/route\.[jt]sx?$/);
  if (appMatch) {
    const inner = appMatch[1];
    if (inner === "") return "/";
    return "/" + inner.replace(/\[([^\]]+)\]/g, ":$1");
  }
  const pagesMatch = file.match(/(?:^|\/)(?:src\/)?pages\/api\/(.+)\.[jt]sx?$/);
  if (pagesMatch) {
    return "/api/" + pagesMatch[1].replace(/\[([^\]]+)\]/g, ":$1").replace(/\/index$/, "");
  }
  return null;
}

const ROUTE_OBJECT_RE = /^(?:app|router|fastify|server|hono)$/i;

// Express / Fastify / Hono route registrations (regex fallback, mirroring
// the vendored probe's shapes).
const ROUTE_REGISTER_FALLBACK_RE =
  /\b(?:app|router|fastify|hono?)\s*\.\s*(get|post|put|patch|delete)\s*\(/gi;
const METHOD_EXPORT_FALLBACK_RE =
  /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|DELETE|PATCH)\b/g;

function regexFallbackRoutes(content: string, file: string): CollectedRoute[] {
  const routes: CollectedRoute[] = [];
  const masked = stripComments(content);
  for (const m of masked.matchAll(ROUTE_REGISTER_FALLBACK_RE)) {
    const method = m[1].toUpperCase();
    const after = masked.slice(m.index + m[0].length, m.index + m[0].length + 300);
    const pathMatch = after.match(/^\s*['"`]([^'"`]+)['"`]/);
    routes.push({
      method,
      path: pathMatch ? pathMatch[1] : "",
      file,
      line: lineOf(content, m.index),
      middlewares: [],
      handlerName: null,
      handlerNode: null,
      parsed: false,
    });
  }
  const nextPath = nextJsRoutePath(file);
  if (nextPath !== null) {
    for (const m of masked.matchAll(METHOD_EXPORT_FALLBACK_RE)) {
      routes.push({
        method: m[1],
        path: nextPath,
        file,
        line: lineOf(content, m.index),
        middlewares: [],
        handlerName: null,
        handlerNode: null,
        parsed: false,
      });
    }
  }
  return routes;
}

// Unwrap a single-argument wrapper call (the asyncRoute(fn) shape, and any
// equivalent single-function wrapper): when the last route argument is a
// CallExpression whose first argument is a function, an identifier, or a
// member expression, that inner argument IS the handler. Returns the handler
// as { name, node } (exactly one set), or null when the wrapper cannot be
// unwrapped — the caller marks the route unresolved instead of guessing at
// a handler it cannot see.
function unwrapWrapperHandler(
  call: AstNode
): { name: string | null; node: AstNode | null } | null {
  let inner: AstNode | null = call;
  while (inner?.type === "CallExpression") {
    const firstArg = (inner.arguments || [])[0];
    if (!firstArg) return null;
    if (FUNCTION_TYPES.has(firstArg.type)) return { name: null, node: firstArg };
    if (firstArg.type === "Identifier") return { name: firstArg.name, node: null };
    if (firstArg.type === "MemberExpression") {
      return { name: readDottedName(firstArg), node: null };
    }
    // A nested wrapper call: unwrap one more level. Anything else (a
    // literal, an object, ...) is not a handler shape: unresolved.
    inner = firstArg;
  }
  return null;
}

// Collect the HTTP routes in one file. AST-first (so the handler function
// node and middleware identifiers are available); a regex fallback when
// the file does not parse. Returns [] for non-code files.
export function collectRoutes(content: string, file: string): CollectedRoute[] {
  if (!/\.[jt]sx?$/.test(file)) return [];
  const ast = parseFile(content, file);
  if (!ast) return regexFallbackRoutes(content, file);
  const routes: CollectedRoute[] = [];
  const nextPath = nextJsRoutePath(file);
  walkAst(ast, (node) => {
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression") {
      const name = readDottedName(node.callee);
      if (!name) return;
      const m = /^(.+)\.(get|post|put|patch|delete)$/i.exec(name);
      if (!m || !ROUTE_OBJECT_RE.test(m[1])) return;
      const args = node.arguments || [];
      if (args.length === 0) return;
      const first = args[0];
      const path = first?.type === "Literal" && typeof first.value === "string" ? first.value : "";
      const middlewares: string[] = [];
      for (const arg of args.slice(1, -1)) {
        if (arg?.type === "Identifier") middlewares.push(arg.name);
        else if (arg?.type === "CallExpression") {
          const callee = arg.callee ? readDottedName(arg.callee) : null;
          if (callee) middlewares.push(callee);
        } else if (arg?.type === "MemberExpression") {
          const n = readDottedName(arg);
          if (n) middlewares.push(n);
        }
      }
      const last = args[args.length - 1];
      let handlerName: string | null = null;
      let handlerNode: AstNode | null = null;
      let handlerUnresolved = false;
      if (last) {
        if (FUNCTION_TYPES.has(last.type)) handlerNode = last;
        else if (last.type === "Identifier") handlerName = last.name;
        else if (last.type === "MemberExpression") handlerName = readDottedName(last);
        else if (last.type === "CallExpression") {
          // Wrapper call (asyncRoute(async (req, res) => {...})): unwrap to
          // the inner function so the probe reads the real handler body.
          // Un-unwrappable: mark unresolved — the probe routes the route to
          // verification, never asserts a missing guard it cannot see.
          const unwrapped = unwrapWrapperHandler(last);
          if (unwrapped) {
            handlerName = unwrapped.name;
            handlerNode = unwrapped.node;
          } else {
            handlerUnresolved = true;
          }
        }
      }
      routes.push({
        method: m[2].toUpperCase(),
        path,
        file,
        line: node.loc?.start?.line ?? 1,
        middlewares,
        handlerName,
        handlerNode,
        parsed: true,
        ...(handlerUnresolved ? { handlerUnresolved: true } : {}),
      });
      return;
    }
    if (nextPath !== null && node.type === "ExportNamedDeclaration" && node.declaration) {
      const d = node.declaration;
      if (d.type === "FunctionDeclaration" && d.id?.name && HTTP_METHODS.has(d.id.name)) {
        routes.push({
          method: d.id.name,
          path: nextPath,
          file,
          line: node.loc?.start?.line ?? 1,
          middlewares: [],
          handlerName: null,
          handlerNode: d,
          parsed: true,
        });
        return;
      }
      if (d.type === "VariableDeclaration") {
        for (const decl of d.declarations || []) {
          if (
            decl.id?.type === "Identifier" &&
            HTTP_METHODS.has(decl.id.name) &&
            decl.init &&
            FUNCTION_TYPES.has(decl.init.type)
          ) {
            routes.push({
              method: decl.id.name,
              path: nextPath,
              file,
              line: node.loc?.start?.line ?? 1,
              middlewares: [],
              handlerName: null,
              handlerNode: decl.init,
              parsed: true,
            });
          }
        }
      }
    }
  });
  return routes;
}

// ---------------------------------------------------------------------------
// Auth / session signals (shared by the rate-limit and CSRF probes).
// These mirror the vendored auth probe's hasAuth shape (auth.js): a bare
// identifier match is enough for the signal, and the list is kept to
// unambiguous auth idioms so a false "authenticated" never hides a
// finding. Callers pass the route-relevant snippet (middleware chain +
// handler body), never the whole file — a file with many routes must not
// attribute one route's auth check to another.
// ---------------------------------------------------------------------------

const AUTH_SIGNAL_RES = [
  /jwt\.verify/i,
  /verifyToken/i,
  /verifyJWT/i,
  /getServerSession/i,
  /getSession/i,
  /requireAuth/i,
  /isAuthenticated/i,
  /\bauthenticate\s*\(/i,
  /authMiddleware/i,
  /\bprotect\s*\(/i,
  /\bguard\s*\(/i,
  /passport\.authenticate/i,
  /clerkMiddleware/i,
  /withAuth/i,
  /getUser/i,
  /currentUser/i,
  /\bauth\s*\(/i,
  /verifySession/i,
  /checkAuth/i,
  /req\.session/i,
  /request\.session/i,
  /req\.user/i,
  /req\.isAuthenticated/i,
  /isLoggedIn/i,
  /verifySignature/i,
  /constructEvent/i,
  /timingSafeEqual/i,
  /Authorization/i,
  /Bearer\s/i,
];

export function hasAuthSignal(text: string): boolean {
  if (!text) return false;
  const masked = stripComments(text);
  return AUTH_SIGNAL_RES.some((re) => re.test(masked));
}

// Session / cookie-auth idioms: a session middleware or a session-cookie
// read. Used by the CSRF probe to establish cookie auth.
const SESSION_SIGNAL_RES = [
  /express-session/i,
  /cookie-session/i,
  /getServerSession/i,
  /req\.session/i,
  /request\.session/i,
  /\bsession\s*\(/i,
  /cookies\s*\(\s*\)\s*\./i,
  /req\.cookies/i,
  /Set-Cookie/i,
  /withAuth/i,
  /clerkMiddleware/i,
];

export function hasSessionSignal(text: string): boolean {
  if (!text) return false;
  const masked = stripComments(text);
  return SESSION_SIGNAL_RES.some((re) => re.test(masked));
}

// ---------------------------------------------------------------------------
// Handler resolution (shared by the rate-limit, CSRF, and file-upload
// probes). A route's handler is usually inline, a same-file function, or
// an import from another file in the scanned set. When it cannot be
// resolved to a scanned file, the probe cannot establish what the handler
// does — that is an "unknown", not a "guarded".
// ---------------------------------------------------------------------------

export interface RouteHandlerInfo {
  // Source text of the handler function, or null when it cannot be
  // resolved to a scanned file.
  bodyText: string | null;
  // False when the handler is a named import that cannot be resolved to
  // a scanned file (or the file does not parse).
  resolved: boolean;
}

// The import specifier a name is imported from, if any (ESM or CJS).
export function importSpecForName(content: string, name: string): string | null {
  const masked = stripComments(content);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let m = new RegExp(
    `import\\s+(?:\\{[^}]*\\b${esc}\\b[^}]*\\}|\\*\\s+as\\s+${esc}|${esc})\\s+from\\s+['"]([^'"]+)['"]`
  ).exec(masked);
  if (m) return m[1];
  m = new RegExp(
    `(?:const|let|var)\\s+(?:\\{[^}]*\\b${esc}\\b[^}]*\\}|${esc})\\s*=\\s*require\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`
  ).exec(masked);
  if (m) return m[1];
  return null;
}

export function resolveRouteHandler(
  route: CollectedRoute,
  files: Map<string, string>,
  knownPaths: Set<string>
): RouteHandlerInfo {
  const content = files.get(route.file);
  if (content === undefined) return { bodyText: null, resolved: false };
  // A wrapper call that could not be unwrapped: the handler body cannot be
  // inspected, so the route is unresolved — the probe routes it to
  // verification rather than asserting a missing guard it cannot see.
  if (route.handlerUnresolved) return { bodyText: null, resolved: false };
  // Inline handler: the function node is on the route.
  if (route.handlerNode) {
    return { bodyText: sourceTextOf(route.handlerNode, content), resolved: true };
  }
  if (!route.handlerName) return { bodyText: null, resolved: true };
  const name = route.handlerName.split(".").pop() ?? route.handlerName;
  // Same-file definition.
  const ast = parseFile(content, route.file);
  if (!ast) return { bodyText: null, resolved: false };
  const local = findNamedFunction(ast, name);
  if (local) return { bodyText: sourceTextOf(local, content), resolved: true };
  // Imported handler: resolve the import to a scanned file.
  const spec = importSpecForName(content, name);
  if (!spec) return { bodyText: null, resolved: false };
  const resolvedPath = resolveRelativeImport(route.file, spec, knownPaths);
  if (!resolvedPath) return { bodyText: null, resolved: false };
  const target = files.get(resolvedPath);
  if (target === undefined) return { bodyText: null, resolved: false };
  const targetAst = parseFile(target, resolvedPath);
  if (!targetAst) return { bodyText: null, resolved: false };
  const fn = findNamedFunction(targetAst, name);
  if (!fn) return { bodyText: null, resolved: false };
  return { bodyText: sourceTextOf(fn, target), resolved: true };
}

// The text inside the parens of a call starting at `openParenIdx`
// (the index of the "("). Null when the parens do not balance.
export function callArgsText(content: string, openParenIdx: number): string | null {
  let depth = 0;
  let i = openParenIdx;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return content.slice(openParenIdx + 1, i);
    }
    i++;
  }
  return null;
}
