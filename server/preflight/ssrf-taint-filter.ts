// First-party calibration for the vendored taint engine's SSRF sink
// (server/preflight/vendor/lib/probes/taint-engine.js, sink
// `ssrf-outbound`, finalread-detector-precision-fix-spec.md Item 3 —
// APPROVED).
//
// The engine's CallExpression propagation (taint-engine.js:537) lets
// taint flow from a database lookup key into EVERY field of the returned
// row, and its SANITIZERS list (taint-engine.js:382) has no URL
// validator and no guard-clearing — so a URL that is stored in the
// database and validated by a safe-URL check still reads as
// "user-controlled". Two conflations: provenance (the lookup key selects
// WHICH row to read; it does not supply the row's fields) and validation
// (a guard that refuses an unsafe URL before the fetch is invisible).
//
// This filter re-parses the file, finds the outbound call at the
// finding's line, and determines the URL argument's provenance:
//   1. Database-stored URL (a member access on a value from a database
//      read, the taint reaching it only through a lookup key) → DROP.
//   2. Validated URL (the URL passed a safe-URL validation guard before
//      the fetch) → DROP.
//   3. Request-derived URL without validation → KEEP as a liability.
//   4. Cannot establish the provenance or the validation → unverified:
//      true, with the specific question in remediation.
//
// Fail-closed (the same rule as the 2026-11-16 taint filter: any
// uncertainty returns false/keep): if the filter cannot establish the
// provenance or the validation, it keeps the finding or routes it to
// verification; it never silently drops. The vendored engine is
// untouched — this is first-party, following the taint-path-filter.ts
// model.
import {
  parseFile,
  readDottedName,
  walkAst,
  findEnclosingFunction,
  findNamedFunction,
  importSpecForName,
  resolveRelativeImport,
  stripComments,
  patternNames,
  sourceTextOf,
  FUNCTION_TYPES,
  type AstNode,
} from "./ast-util";

// Minimal structural type for the raw vendor findings this filter sees.
export interface SsrfFindingLike {
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

const SSRF_ID_PREFIX = "taint-ssrf-outbound-";

export const SSRF_PROVENANCE_QUESTION =
  "Is the fetched URL built from a request value, or does it come from a stored or validated source? Point at the code that settles it.";

// The engine's request-input sources (taint-engine.js:96), mirrored here.
const HTTP_INPUT_RE =
  /^(?:req|request|ctx|context|event|c\.req)\.(?:body|query|params|headers|cookies|searchParams|url|originalUrl|path|baseUrl|queryStringParameters)(?:\.[A-Za-z_$][\w$]*)*$/;
const BODY_READ_RE =
  /^(?:req|request|ctx|context|event|c\.req)\.(?:json|text|formData|arrayBuffer|blob)$/;

// A URL-validation guard: isSafeRemoteUrl, isSafeUrl, isValidUrl,
// validateUrl, isAllowedUrl, or an equivalent.
const URL_VALIDATOR_RE =
  /(?:^|\.)(?:isSafe(?:Remote)?Url|isValid(?:Remote)?Url|validate(?:Remote)?Url|isAllowedUrl|assertSafeUrl|checkUrl|isSafeURL)$/i;

// Fetch-like callees (the engine's ssrf-outbound sink shapes,
// taint-engine.js:295). Aliased identifiers cannot be resolved here —
// a call the filter cannot recognise is "cannot establish", not a drop.
const FETCH_MEMBER_RE =
  /^(?:axios|got|superagent|needle|undici)\.(?:get|post|put|patch|delete|head|request|fetch)$|^https?\.(?:get|request)$|^undici\.fetch$/;

type Provenance = "db" | "request" | "other" | "unknown";

// ---------------------------------------------------------------------------
// Database reads
// ---------------------------------------------------------------------------

// The innermost callee of a (possibly chained) call, e.g. `db.select` for
// `db.select().from(x).where(y).limit(1)`.
function rootCalleeName(call: AstNode): string | null {
  let callee = call.callee;
  while (callee?.type === "MemberExpression") {
    const obj = callee.object;
    if (obj?.type === "CallExpression") callee = obj.callee;
    else break;
  }
  return readDottedName(callee);
}

// True when `node` is a database READ (a query whose result is a stored
// row). Writes (insert/update/delete) do NOT count: a value from a row
// that was just inserted from request data in the same request is still
// request-derived, so only reads establish "stored".
function isDbReadExpression(node: AstNode, content: string): boolean {
  let n = node;
  while (n?.type === "AwaitExpression") n = n.argument;
  if (!n || n.type !== "CallExpression") return false;
  const root = rootCalleeName(n);
  if (!root) return false;
  // DB client read methods: db.select / db.query / prisma… / tx.select …
  if (/^(?:db|tx|prisma|knex|pool|client|connection|database|orm)\.(?:select|query|execute|get|all|getOne|getMany)$/.test(root))
    return true;
  // ORM model read methods, any receiver.
  if (
    /(?:^|\.)(?:findMany|findFirst|findUnique|findUniqueOrThrow|findOne|findById|findOneAndUpdate|findOneAndDelete|findAll|findByPk)$/.test(
      root
    )
  )
    return true;
  // Drizzle / Knex read chain: .select().from(…
  const src = sourceTextOf(n, content);
  if (/\.select\s*\(\s*\)\s*\.from\s*\(/.test(src)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function provenanceOf(
  expr: AstNode,
  scope: Map<string, Provenance>,
  content: string,
  seen: Set<string> = new Set()
): Provenance {
  if (!expr || typeof expr !== "object") return "unknown";
  if (expr.type === "MemberExpression") {
    const name = readDottedName(expr);
    if (name && HTTP_INPUT_RE.test(name)) return "request";
    if (name && /^(?:process\.env|import\.meta\.env|Bun\.env)\./.test(name)) return "other";
    if (
      name === "document.cookie" ||
      name === "location.hash" ||
      name === "location.search" ||
      name === "location.pathname" ||
      name === "window.name"
    )
      return "request";
    return provenanceOf(expr.object, scope, content, seen);
  }
  if (expr.type === "CallExpression") {
    if (isDbReadExpression(expr, content)) return "db";
    if (expr.callee?.type === "MemberExpression") {
      const name = readDottedName(expr.callee);
      if (name && BODY_READ_RE.test(name)) return "request";
      if (
        name === "localStorage.getItem" ||
        name === "sessionStorage.getItem"
      )
        return "request";
      const recv = provenanceOf(expr.callee.object, scope, content, seen);
      if (recv === "request" || recv === "db") return recv;
    }
    for (const arg of expr.arguments || []) {
      const t = provenanceOf(arg, scope, content, seen);
      if (t === "request") return "request";
    }
    for (const arg of expr.arguments || []) {
      const t = provenanceOf(arg, scope, content, seen);
      if (t === "db") return "db";
    }
    return "unknown";
  }
  if (expr.type === "Identifier") {
    if (seen.has(expr.name)) return "unknown";
    seen.add(expr.name);
    return scope.get(expr.name) ?? "unknown";
  }
  if (expr.type === "Literal") return "other";
  if (expr.type === "TemplateLiteral") {
    let sawDb = false;
    for (const ex of expr.expressions || []) {
      const t = provenanceOf(ex, scope, content, seen);
      if (t === "request") return "request";
      if (t === "db") sawDb = true;
    }
    return sawDb ? "db" : "unknown";
  }
  if (expr.type === "BinaryExpression" && expr.operator === "+") {
    const l = provenanceOf(expr.left, scope, content, seen);
    if (l === "request") return "request";
    const r = provenanceOf(expr.right, scope, content, seen);
    if (r === "request") return "request";
    if (l === "db" || r === "db") return "db";
    return "unknown";
  }
  if (expr.type === "LogicalExpression") {
    const l = provenanceOf(expr.left, scope, content, seen);
    if (l === "request") return "request";
    const r = provenanceOf(expr.right, scope, content, seen);
    if (r === "request") return "request";
    if (l === "db" || r === "db") return "db";
    return "unknown";
  }
  if (expr.type === "ConditionalExpression") {
    const c = provenanceOf(expr.consequent, scope, content, seen);
    if (c === "request") return "request";
    const a = provenanceOf(expr.alternate, scope, content, seen);
    if (a === "request") return "request";
    if (c === "db" || a === "db") return "db";
    return "unknown";
  }
  if (expr.type === "AwaitExpression") return provenanceOf(expr.argument, scope, content, seen);
  if (expr.type === "SequenceExpression") {
    const exprs = expr.expressions || [];
    return provenanceOf(exprs[exprs.length - 1], scope, content, seen);
  }
  return "unknown";
}

// Identifier -> provenance, for the function containing the sink, as of
// the sink call (bindings defined after the call are not in scope).
function buildProvenanceScope(
  fn: AstNode | null,
  sinkCall: AstNode,
  content: string
): Map<string, Provenance> {
  const scope = new Map<string, Provenance>();
  if (!fn) return scope;
  for (const p of fn.params || []) {
    if (p.type === "Identifier" && /^(?:req|request|ctx|event)$/.test(p.name)) {
      scope.set(p.name, "request");
    }
  }
  let stopped = false;
  const record = (pattern: AstNode, init: AstNode | null) => {
    if (!pattern || !init) return;
    const t = provenanceOf(init, scope, content);
    if (pattern.type === "Identifier") {
      scope.set(pattern.name, t);
    } else if (pattern.type === "ObjectPattern" || pattern.type === "ArrayPattern") {
      for (const name of patternNames(pattern)) scope.set(name, t);
    }
  };
  const walk = (node: AstNode) => {
    if (!node || typeof node !== "object" || stopped) return;
    if (node === sinkCall) {
      stopped = true;
      return;
    }
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations || []) record(d.id, d.init ?? null);
    } else if (node.type === "AssignmentExpression") {
      if (node.left?.type === "Identifier") {
        scope.set(node.left.name, provenanceOf(node.right, scope, content));
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
  if (fn.body) walk(fn.body);
  return scope;
}

// ---------------------------------------------------------------------------
// URL-validation guards
// ---------------------------------------------------------------------------

// Does `node` (an if-test) call a URL validator on the URL value?
function testValidatesUrl(
  node: AstNode,
  urlSourceText: string,
  urlDottedName: string | null,
  content: string
): boolean {
  let found = false;
  walkAst(node, (n) => {
    if (found || !n || typeof n !== "object") return;
    if (n.type !== "CallExpression") return;
    const calleeName = n.callee ? readDottedName(n.callee) : null;
    if (!calleeName || !URL_VALIDATOR_RE.test(calleeName)) return;
    for (const arg of n.arguments || []) {
      const argText = sourceTextOf(arg, content);
      const argName = readDottedName(arg);
      if (
        (urlSourceText && argText === urlSourceText) ||
        (urlDottedName && argName === urlDottedName)
      ) {
        found = true;
        return;
      }
    }
  });
  return found;
}

// Does `node` (an if consequent) exit the function (return / throw)?
function consequentExits(node: AstNode): boolean {
  let exits = false;
  walkAst(node, (n) => {
    if (exits) return false;
    if (n.type === "ReturnStatement" || n.type === "ThrowStatement") {
      exits = true;
      return false;
    }
    // Do not descend into nested functions: their returns are not ours.
    if (n !== node && FUNCTION_TYPES.has(n.type)) return false;
  });
  return exits;
}

// Does the if-test test a validation flag negatively (!ok, ok === false…)?
function testRejectsFlag(node: AstNode, flagName: string): boolean {
  let found = false;
  walkAst(node, (n) => {
    if (found || !n || typeof n !== "object") return;
    if (n.type === "UnaryExpression" && n.operator === "!" && n.argument?.type === "Identifier" && n.argument.name === flagName) {
      found = true;
      return;
    }
    if (
      n.type === "BinaryExpression" &&
      (n.operator === "===" || n.operator === "==" || n.operator === "!==" || n.operator === "!=")
    ) {
      const leftIsFlag = n.left?.type === "Identifier" && n.left.name === flagName;
      const rightIsFlag = n.right?.type === "Identifier" && n.right.name === flagName;
      const other = leftIsFlag ? n.right : rightIsFlag ? n.left : null;
      if (
        other?.type === "Literal" &&
        other.value === false &&
        (n.operator === "===" || n.operator === "==" ? leftIsFlag || rightIsFlag : false)
      ) {
        found = true;
        return;
      }
      if (
        other?.type === "Literal" &&
        other.value === true &&
        (n.operator === "!==" || n.operator === "!=")
      ) {
        found = true;
        return;
      }
    }
  });
  return found;
}

// True when the URL passed a safe-URL validation guard before the fetch:
// a validator call on the same value inside an if-test that exits, or a
// validator result assigned to a flag that an if-test then rejects.
function isUrlValidated(
  fn: AstNode | null,
  sinkCall: AstNode,
  urlNode: AstNode,
  content: string
): boolean {
  if (!fn) return false;
  const urlSourceText = sourceTextOf(urlNode, content);
  const urlDottedName = readDottedName(urlNode);
  const flags = new Set<string>();
  let validated = false;
  let stopped = false;
  const walk = (node: AstNode) => {
    if (!node || typeof node !== "object" || stopped || validated) return;
    if (node === sinkCall) {
      stopped = true;
      return;
    }
    // A validator result assigned to a flag: const ok = isSafeUrl(u).
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations || []) {
        if (!d.init || d.init.type !== "CallExpression") continue;
        const calleeName = d.init.callee ? readDottedName(d.init.callee) : null;
        if (!calleeName || !URL_VALIDATOR_RE.test(calleeName)) continue;
        for (const arg of d.init.arguments || []) {
          const argText = sourceTextOf(arg, content);
          const argName = readDottedName(arg);
          if (
            (urlSourceText && argText === urlSourceText) ||
            (urlDottedName && argName === urlDottedName)
          ) {
            if (d.id?.type === "Identifier") flags.add(d.id.name);
          }
        }
      }
    }
    if (node.type === "IfStatement") {
      const test = node.test;
      const exits = node.consequent ? consequentExits(node.consequent) : false;
      if (exits && testValidatesUrl(test, urlSourceText, urlDottedName, content)) {
        validated = true;
        return;
      }
      if (exits) {
        for (const flag of flags) {
          if (testRejectsFlag(test, flag)) {
            validated = true;
            return;
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (stopped || validated) return;
      if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const child of val) {
          if (stopped || validated) return;
          if (child && FUNCTION_TYPES.has(child.type)) continue;
          walk(child);
        }
      } else if (val && typeof val === "object") {
        if (FUNCTION_TYPES.has(val.type)) continue;
        walk(val);
      }
    }
  };
  if (fn.body) walk(fn.body);
  return validated;
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

// Find the fetch-like CallExpression starting at `line`, or null.
function findSinkCall(ast: AstNode, line: number): AstNode | null {
  let found: AstNode | null = null;
  walkAst(ast, (node) => {
    if (found || !node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.loc?.start?.line === line) {
      const callee = node.callee;
      if (callee?.type === "Identifier" && callee.name === "fetch") {
        found = node;
        return;
      }
      if (callee?.type === "MemberExpression") {
        const name = readDottedName(callee);
        if (name && FETCH_MEMBER_RE.test(name)) {
          found = node;
          return;
        }
      }
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Transport-probe SSRF findings (finalread-self-scan-fixes-spec.md A2)
// ---------------------------------------------------------------------------

// The vendored transport probe (probes/transport.js probeSSRFOpenRedirect)
// fires a line regex: an HTTP-client token followed by `(` and user input.
// The token `request` matches ANY identifier containing it, so a database
// call such as rebindProjectRequest with a request id reads as a fetch. Its
// findings carry id `ssrf-<file>-<line>` (probe "SSRF") and never reach the
// taint calibration above, which only handles `taint-ssrf-outbound-` ids —
// that is why the self-scan showed it as a hard high. This branch verifies
// the flagged call actually touches the network: resolve the callee; a
// callee whose body performs no outbound request is dropped; a callee
// that cannot be resolved routes to verification, never a hard high.
const TRANSPORT_SSRF_ID_PREFIX = "ssrf-";

export const SSRF_CALLEE_QUESTION =
  "Does this call perform an outbound network request, or is it a local/database helper? Point at the call that settles it.";

// An outbound-request call inside a function body: fetch, the HTTP client
// packages, or node:http(s). Generous on purpose — a match KEEPS the
// finding (fail-closed); only a body with no such call is dropped. Comments
// are stripped first so a commented-out fetch cannot keep a finding.
const NETWORK_CALL_RE =
  /\bfetch\s*\(|axios\s*(?:\.\s*[A-Za-z_$][\w$]*)?\s*\(|got\s*(?:\.\s*[A-Za-z_$][\w$]*)?\s*\(|undici\s*\.\s*(?:fetch|request)\s*\(|https?\s*\.\s*(?:get|request)\s*\(|superagent\s*(?:\.\s*[A-Za-z_$][\w$]*)?\s*\(|ky\s*(?:\.\s*[A-Za-z_$][\w$]*)?\s*\(|phin\s*\(|node-fetch|\brequest\s*\(/;

function bodyTouchesNetwork(bodyText: string): boolean {
  return NETWORK_CALL_RE.test(stripComments(bodyText));
}

// HTTP-client packages called by their package name (axios(url), got(url),
// request(url)). With no local definition shadowing the name, the call is
// the client itself.
const NETWORK_CALLEE_IDENTIFIERS = new Set([
  "axios",
  "got",
  "ky",
  "superagent",
  "phin",
  "request",
  "undici",
]);

// Resolve a bare callee identifier to its function body text: same-file
// definition first, then a relative import (mirrors resolveRouteHandler).
// Null when it cannot be resolved — a package import is not a local
// definition, so it resolves to null here and the caller decides by name.
function resolveCalleeBody(
  name: string,
  file: string,
  content: string,
  files: Map<string, string>
): string | null {
  const ext = file.match(/\.[jt]sx?$/)?.[0] || ".js";
  const ast = parseFile(content, ext);
  if (!ast) return null;
  const local = findNamedFunction(ast, name);
  if (local) return sourceTextOf(local, content);
  const spec = importSpecForName(content, name);
  if (!spec) return null;
  const knownPaths = new Set(files.keys());
  const resolvedPath = resolveRelativeImport(file, spec, knownPaths);
  if (!resolvedPath) return null;
  const target = files.get(resolvedPath);
  if (target === undefined) return null;
  const targetAst = parseFile(target, resolvedPath);
  if (!targetAst) return null;
  const fn = findNamedFunction(targetAst, name);
  if (!fn) return null;
  return sourceTextOf(fn, target);
}

// The HTTP-client token family the vendored transport probe matches on
// (transport.js HTTP_CLIENT): prefer the call whose callee carries one of
// these tokens, since that is the call the regex flagged; otherwise the
// first call on the line.
const TRANSPORT_TOKEN_RE =
  /fetch|axios|got|request|ky|phin|undici|superagent|node-fetch|https?/i;

function findCallAtLine(ast: AstNode, line: number): AstNode | null {
  const calls: AstNode[] = [];
  walkAst(ast, (node) => {
    if (node?.type === "CallExpression" && node.loc?.start?.line === line) {
      calls.push(node);
    }
  });
  if (calls.length === 0) return null;
  for (const c of calls) {
    const callee = c.callee;
    const name =
      callee?.type === "Identifier"
        ? callee.name
        : callee?.type === "MemberExpression"
          ? readDottedName(callee)
          : null;
    if (name && TRANSPORT_TOKEN_RE.test(name)) return c;
  }
  return calls[0];
}

// Verify a transport-probe SSRF finding: "keep" (a real outbound sink),
// "drop" (the callee is a local/database helper that never networks), or
// "verify" (the callee cannot be established).
function transportSsrfVerdict(
  f: SsrfFindingLike,
  content: string,
  files: Map<string, string>
): "keep" | "drop" | "verify" {
  const file = typeof f.file === "string" ? f.file : "";
  const line = typeof f.line === "number" ? f.line : null;
  const ext = file.match(/\.[jt]sx?$/)?.[0] || ".js";
  const ast = parseFile(content, ext);
  if (!ast || line === null) return "verify";
  const call = findCallAtLine(ast, line);
  if (!call) return "verify";
  const callee = call.callee;
  // A member call that IS a network client (axios.get, https.get,
  // undici.fetch) is a real sink. Any other member call cannot be
  // resolved through its receiver: verification, not a drop.
  if (callee?.type === "MemberExpression") {
    const name = readDottedName(callee);
    if (name && FETCH_MEMBER_RE.test(name)) return "keep";
    return "verify";
  }
  if (callee?.type !== "Identifier") return "verify";
  const name = callee.name;
  // The global fetch is a network sink.
  if (name === "fetch") return "keep";
  const body = resolveCalleeBody(name, file, content, files);
  if (body !== null) {
    return bodyTouchesNetwork(body) ? "keep" : "drop";
  }
  // No local definition: a known HTTP-client package name is the client.
  if (NETWORK_CALLEE_IDENTIFIERS.has(name)) return "keep";
  return "verify";
}

export function calibrateSsrfTaintFindings<T extends SsrfFindingLike>(
  findings: T[],
  files: Map<string, string>
): T[] {
  const out: T[] = [];
  for (const f of findings) {
    const id = typeof f.id === "string" ? f.id : "";
    const isTaintSsrf = id.startsWith(SSRF_ID_PREFIX);
    const isTransportSsrf = id.startsWith(TRANSPORT_SSRF_ID_PREFIX);
    if (!isTaintSsrf && !isTransportSsrf) {
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
    // Transport-probe finding: verify the flagged call touches the network.
    if (isTransportSsrf) {
      const verdict = transportSsrfVerdict(f, content, files);
      if (verdict === "drop") continue; // DROP
      if (verdict === "verify") {
        out.push({
          ...f,
          unverified: true,
          remediation: SSRF_CALLEE_QUESTION,
        });
        continue;
      }
      out.push(f);
      continue;
    }
    const line = typeof f.line === "number" ? f.line : null;
    const ext = file.match(/\.[jt]sx?$/)?.[0] || ".js";
    const ast = parseFile(content, ext);
    // Unparsable: keep the finding. Fail-closed.
    if (!ast || line === null) {
      out.push(f);
      continue;
    }
    const sinkCall = findSinkCall(ast, line);
    // The outbound call is not at the finding's line: the provenance
    // cannot be established. Route to verification (spec step 4).
    if (!sinkCall) {
      out.push({
        ...f,
        unverified: true,
        remediation: SSRF_PROVENANCE_QUESTION,
      });
      continue;
    }
    const args = sinkCall.arguments || [];
    if (args.length === 0) {
      out.push({
        ...f,
        unverified: true,
        remediation: SSRF_PROVENANCE_QUESTION,
      });
      continue;
    }
    const urlNode = args[0];
    const fn = findEnclosingFunction(ast, line);
    const scope = buildProvenanceScope(fn, sinkCall, content);
    const provenance = provenanceOf(urlNode, scope, content);

    // Step 1 — database-stored URL: drop.
    if (provenance === "db") continue; // DROP
    // Step 2 — validated URL: drop.
    if (isUrlValidated(fn, sinkCall, urlNode, content)) continue; // DROP
    // Step 3 — request-derived URL without validation: keep.
    if (provenance === "request") {
      out.push(f);
      continue;
    }
    // Step 4 — cannot establish: verification.
    out.push({
      ...f,
      unverified: true,
      remediation: SSRF_PROVENANCE_QUESTION,
    });
  }
  return out;
}
