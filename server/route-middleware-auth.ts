// Route-middleware auth resolution (finalread-route-middleware-auth-spec.md).
//
// The vendored API-route-auth probe (server/preflight/vendor/lib/probes/auth.js)
// decides "has auth" from a fixed middleware-NAME allowlist and only examines
// the last route argument (the handler). A route gated by a custom middleware
// (e.g. requireApiKey) therefore keeps its "without auth check" finding even
// though the gate is real. This module resolves the route's middleware
// arguments to their in-file definitions and checks whether any of them
// actually verifies the caller — behavior, not names.
//
// The finding is DOWNGRADED to needs developer verification, never deleted:
// the body check proves the gate is shaped right, but a static scan cannot
// prove the secret it compares against is set in the deployment (an unset
// env var fails open: `undefined !== undefined` is false). Only a human
// dismisses.
//
// First-party copies of the vendored arg/body helpers (extractCallArgs,
// splitTopLevelArgs, isDefinedInFile, extractFunctionBody) live here — those
// helpers are not exported from the vendored module, so they cannot be
// imported. The vendored probe itself is never edited (VENDORED.md). Parity
// against the vendored helpers is behavioral (fixture agreement through the
// probe's observable findings, plus unit tests on these copies), not
// function-level, because the originals are not exported.
//
// The body check is a heuristic, not control-flow proof: it is a regex over
// text. The dangerous shapes it cannot prove absent (inverted logic, a 401
// without return followed by next(), an unused comparison result, a rejection
// in an unrelated branch) are must-keep fixtures in
// test/route-middleware-auth.test.ts — the check keeps those findings.

import type { PreFlightFinding } from "../shared/preflight-types";

/** The probe's no-auth title shape: "GET /api/admin/users without auth check". */
export const NO_AUTH_TITLE =
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) without auth check$/;

export type GateMechanism = "API-key" | "JWT" | "session" | "token" | "auth";

export interface VerifiedRouteGate {
  method: string;
  route: string;
  middlewareName: string;
  file: string;
  /** 1-based line of the middleware definition (or the route line for inline middleware). */
  line: number;
  mechanism: GateMechanism;
}

export interface MiddlewareAuthResolution {
  findings: PreFlightFinding[];
  gates: VerifiedRouteGate[];
}

// ---------------------------------------------------------------------------
// First-party copies of the vendored helpers (auth.js:1298-1499).
// Faithful ports, typed. The vendored originals are plain `function`s, not
// exports, so they cannot be imported.
// ---------------------------------------------------------------------------

export function isDefinedInFile(name: string, content: string): boolean {
  const esc = name.replace(/\$/g, "\\$");
  // A real implementation in this file: function NAME(, const NAME = function,
  // const NAME = (, NAME = (...) =>, NAME = x =>. Import/require bindings do
  // NOT count — their bodies are invisible to the per-file probe.
  return new RegExp(
    `\\bfunction\\s+${esc}\\s*\\(` +
      `|\\b(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?function\\b` +
      `|\\b(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s*)?\\(` +
      `|\\b${esc}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>` +
      `|\\b${esc}\\s*=\\s*(?:async\\s*)?[A-Za-z_$][\\w$]*\\s*=>`
  ).test(content);
}

export function extractCallArgs(content: string, fromIndex: number): string | null {
  const openIdx = content.indexOf("(", fromIndex);
  if (openIdx === -1) return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (ch === inStr && content[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i);
      i = nl === -1 ? content.length : nl;
      continue;
    }
    if (ch === "/" && content[i + 1] === "*") {
      const ec = content.indexOf("*/", i + 2);
      i = ec === -1 ? content.length : ec + 1;
      continue;
    }
    // Note: `${}` inside template literals is not tracked; a route call
    // whose args contain one degrades to null and keeps today's behavior.
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return content.slice(openIdx + 1, i);
    }
  }
  return null;
}

export function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr: string | null = null;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (inStr) {
      cur += ch;
      if (ch === inStr && argsText[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  args.push(cur);
  return args;
}

/** A function definition found in the file: its brace-balanced body and 1-based line. */
export interface FunctionDefinition {
  body: string;
  line: number;
}

function matchFunctionDefinition(
  content: string,
  name: string
): { match: RegExpMatchArray; index: number } | null {
  const esc = name.replace(/\$/g, "\\$");
  const def =
    content.match(new RegExp(`\\b(?:async\\s+)?function\\s+${esc}\\s*\\([^)]*\\)\\s*\\{`)) ||
    content.match(
      new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?function\\s*\\([^)]*\\)\\s*\\{`)
    ) ||
    content.match(
      new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`)
    );
  if (!def || def.index === undefined) return null;
  return { match: def, index: def.index };
}

export function findFunctionDefinition(content: string, name: string): FunctionDefinition | null {
  const found = matchFunctionDefinition(content, name);
  if (!found) return null;
  const openIdx = content.indexOf("{", found.index);
  if (openIdx === -1) return null;
  const braced = matchBraces(content, openIdx);
  if (!braced) return null;
  const line = content.slice(0, found.index).split("\n").length;
  return { body: braced.content, line };
}

// Body of an in-file function definition, brace-balanced (strings and
// comments skipped the same way extractCallArgs scans). Null when the
// definition cannot be located or balanced — callers fall back to the
// call-site args, which keeps today's behavior (flag) for those routes.
export function extractFunctionBody(content: string, name: string): string | null {
  const found = findFunctionDefinition(content, name);
  return found ? found.body : null;
}

// ---------------------------------------------------------------------------
// Small brace/paren scanners, same discipline as the vendored helpers
// (strings and comments skipped; `${}` inside template literals not tracked).
// ---------------------------------------------------------------------------

/** Given the index of `(`, return the text inside and the index just after the matching `)`. */
function matchParens(text: string, openIdx: number): { content: string; end: number } | null {
  if (text[openIdx] !== "(") return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === inStr && text[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const ec = text.indexOf("*/", i + 2);
      i = ec === -1 ? text.length : ec + 1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { content: text.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Given the index of `{`, return the text inside and the index just after the matching `}`. */
function matchBraces(text: string, openIdx: number): { content: string; end: number } | null {
  if (text[openIdx] !== "{") return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === inStr && text[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const ec = text.indexOf("*/", i + 2);
      i = ec === -1 ? text.length : ec + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { content: text.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Blank comment spans to spaces (newlines kept, so indices and line numbers
 * are unchanged). A comment must never create a gate: `// reject when the
 * key !== expected` is prose, not a check. Strings are left intact — the
 * credential reads reference string literals ('x-api-key').
 */
export function stripComments(text: string): string {
  const out = text.split("");
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === inStr && text[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j - 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const ec = text.indexOf("*/", i + 2);
      const end = ec === -1 ? text.length : ec + 2;
      for (let j = i; j < end; j++) {
        if (out[j] !== "\n") out[j] = " ";
      }
      i = end - 1;
      continue;
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// The three-part middleware body check (heuristic).
// ---------------------------------------------------------------------------

interface CredentialRead {
  /** The exact source text of the read, e.g. `req.headers['x-api-key']` or a bound variable name. */
  expr: string;
  mechanism: GateMechanism;
  index: number;
}

function mechanismForCredentialName(name: string): GateMechanism {
  if (/api[-_]?key/i.test(name)) return "API-key";
  if (/authorization/i.test(name)) return "JWT";
  if (/token/i.test(name)) return "token";
  if (/session/i.test(name)) return "session";
  return "auth";
}

/** (a) Credential read: where the credential value comes from. */
function findCredentialReads(body: string): CredentialRead[] {
  const reads: CredentialRead[] = [];
  const push = (expr: string, nameForMechanism: string, index: number) => {
    reads.push({ expr, mechanism: mechanismForCredentialName(nameForMechanism), index });
  };
  const patterns: Array<{ re: RegExp; nameGroup: number }> = [
    { re: /req\.headers\s*\[\s*['"]([^'"]+)['"]\s*\]/g, nameGroup: 1 },
    { re: /req\.headers\.([A-Za-z_$][\w$]*)/g, nameGroup: 1 },
    { re: /req\.get\s*\(\s*['"]([^'"]+)['"]\s*\)/g, nameGroup: 1 },
    { re: /req\.header\s*\(\s*['"]([^'"]+)['"]\s*\)/g, nameGroup: 1 },
    { re: /req\.cookies\s*\[\s*['"]([^'"]+)['"]\s*\]/g, nameGroup: 1 },
    { re: /req\.cookies\.([A-Za-z_$][\w$]*)/g, nameGroup: 1 },
    { re: /req\.(?:body|query)\s*\[\s*['"](token|apiKey|api_key|xApiKey)['"]\s*\]/g, nameGroup: 1 },
    { re: /req\.(?:body|query)\.(token|apiKey|api_key|xApiKey)/g, nameGroup: 1 },
  ];
  for (const { re, nameGroup } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const name = m[nameGroup];
      if (!name) continue;
      // Header/cookie names must look like a credential; a bare
      // `req.headers.host` or `req.cookies.theme` is not one.
      if (!/(authorization|x-api-key|api[-_]?key|apikey|token|session)/i.test(name)) continue;
      push(m[0], name, m.index);
    }
  }
  // req.session / req.session.user — a session read.
  const sessionRe = /req\.session(?:\.[A-Za-z_$][\w$]*|\s*\[\s*['"][^'"]+['"]\s*\])?/g;
  let sm: RegExpExecArray | null;
  while ((sm = sessionRe.exec(body)) !== null) {
    push(sm[0], "session", sm.index);
  }
  // Destructured token: const { token } = req.body — the variable IS the read.
  const destRe = /\{\s*[^}]*\b(token|apiKey|api_key)\b[^}]*\}\s*=\s*req\.(?:body|query)/g;
  let dm: RegExpExecArray | null;
  while ((dm = destRe.exec(body)) !== null) {
    const name = dm[1];
    if (!name) continue;
    push(name, name, dm.index);
  }
  return reads;
}

/**
 * Value aliases: `const key = req.headers['x-api-key']` binds the credential
 * value to a name, and the comparison then uses the name. One hop only.
 * The right-hand side must be the read value itself — optionally with a
 * member/index/call chain (`req.headers.authorization.split(' ')[1]`) or a
 * `||`/`??` fallback. A comparison on the right-hand side binds a BOOLEAN,
 * not the value, so `const ok = <comparison>` is deliberately NOT resolved —
 * the comparison is not in the `if` condition there, so the finding stays
 * (safe direction; see the known-kept fixture in the tests).
 */
function findValueAliases(
  body: string,
  reads: CredentialRead[]
): Map<string, GateMechanism> {
  const aliases = new Map<string, GateMechanism>();
  const assignRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;,\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(body)) !== null) {
    const name = m[1];
    const rhs = m[2].trim();
    if (!name || !rhs) continue;
    const read = reads.find((r) => isDerivedFromRead(rhs, r.expr));
    if (read) aliases.set(name, read.mechanism);
  }
  return aliases;
}

/** Is `rhs` the read value itself (optionally chained or with a fallback)? */
function isDerivedFromRead(rhs: string, expr: string): boolean {
  if (!rhs.startsWith(expr)) return false;
  const rest = rhs.slice(expr.length).trim();
  if (rest === "") return true;
  // A chain of .member / [index] / (args) segments, optionally ending in a
  // || / ?? fallback. Anything else (a comparison, &&, arithmetic) is not
  // the value.
  return /^(\s*(\.[A-Za-z_$][\w$]*|\[[^\]]*\]|\(\s*[^)]*\)|\|\||\?\?)\s*)*$/.test(rest);
}

interface CredentialCheck {
  /** "comparison" (`cred !== expected`), "verify" (`jwt.verify(cred, …)`), or "read" (bare truthiness). */
  kind: "comparison" | "verify" | "read";
  index: number;
  /** For comparisons: the operator. Undefined for verify/read checks. */
  operator?: string;
  mechanism: GateMechanism;
}

/**
 * (b) Verification, part 1: comparisons and verify-calls involving a
 * credential reference. A reference is a read expression or a value alias.
 */
function findCredentialChecks(
  body: string,
  refs: Array<{ text: string; mechanism: GateMechanism }>
): CredentialCheck[] {
  const checks: CredentialCheck[] = [];
  const refByText = new Map(refs.map((r) => [r.text, r.mechanism]));

  // Comparisons: extract the operands around each ===/!==/==/!= and keep
  // the ones where one side is exactly a credential reference.
  const opRe = /(===|!==|==|!=)/g;
  let om: RegExpExecArray | null;
  while ((om = opRe.exec(body)) !== null) {
    const left = extractOperandBefore(body, om.index);
    const right = extractOperandAfter(body, om.index + om[0].length);
    const leftMech = left !== null ? refByText.get(left) : undefined;
    const rightMech = right !== null ? refByText.get(right) : undefined;
    const mechanism = leftMech ?? rightMech;
    if (mechanism !== undefined) {
      checks.push({ kind: "comparison", index: om.index, operator: om[0], mechanism });
    }
  }

  // Verify-calls: jwt.verify / bcrypt.compare / argon2.verify with the
  // credential as an argument.
  const verifyRe = /\b(?:jwt\.verify|bcrypt\.compare|argon2\.verify)\s*\(/g;
  let vm: RegExpExecArray | null;
  while ((vm = verifyRe.exec(body)) !== null) {
    const parens = matchParens(body, body.indexOf("(", vm.index));
    if (!parens) continue;
    const argText = parens.content;
    const ref = refs.find((r) => new RegExp(`(^|[^\\w$])${escapeRegExp(r.text)}([^\\w$]|$)`).test(argText));
    if (ref) {
      checks.push({ kind: "verify", index: vm.index, mechanism: ref.mechanism });
    }
  }
  return checks;
}

/** Operand text immediately before `endIdx` (whitespace skipped), or null. */
function extractOperandBefore(body: string, endIdx: number): string | null {
  let i = endIdx - 1;
  while (i >= 0 && /\s/.test(body[i])) i--;
  let j = i;
  while (j >= 0 && /[\w$.\[\]'\"-]/.test(body[j])) j--;
  const text = body.slice(j + 1, i + 1);
  return text.length > 0 ? text : null;
}

/** Operand text immediately after `startIdx` (whitespace skipped), or null. */
function extractOperandAfter(body: string, startIdx: number): string | null {
  let i = startIdx;
  while (i < body.length && /\s/.test(body[i])) i++;
  let j = i;
  while (j < body.length && /[\w$.\[\]'\"-]/.test(body[j])) j++;
  const text = body.slice(i, j);
  return text.length > 0 ? text : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- `if` parsing -----------------------------------------------------------

interface ParsedIf {
  ifIndex: number;
  condText: string;
  condStart: number;
  condEnd: number;
  thenText: string;
  thenEnd: number;
  elseText: string | null;
  elseEnd: number | null;
  elseIsIf: boolean;
  /** Index just after the whole if statement. */
  end: number;
}

function skipWhitespace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Parse one `if` statement starting at `ifIndex` (the `i` of `if`). */
function parseIf(text: string, ifIndex: number): ParsedIf | null {
  let i = skipWhitespace(text, ifIndex + 2);
  if (text[i] !== "(") return null;
  const condStart = i;
  const parens = matchParens(text, i);
  if (!parens) return null;
  const condText = parens.content;
  const condEnd = parens.end;
  i = skipWhitespace(text, condEnd);
  let thenText: string;
  let thenEnd: number;
  if (text[i] === "{") {
    const braced = matchBraces(text, i);
    if (!braced) return null;
    thenText = braced.content;
    thenEnd = braced.end;
  } else {
    const stmt = parseSingleStatement(text, i);
    if (!stmt) return null;
    thenText = stmt.text;
    thenEnd = stmt.end;
  }
  i = skipWhitespace(text, thenEnd);
  let elseText: string | null = null;
  let elseEnd: number | null = null;
  let elseIsIf = false;
  if (text.slice(i, i + 4) === "else" && !/[\w$]/.test(text[i + 4] ?? "")) {
    i = skipWhitespace(text, i + 4);
    if (text.slice(i, i + 2) === "if" && !/[\w$]/.test(text[i + 2] ?? "")) {
      elseIsIf = true;
      const nested = parseIf(text, i);
      if (!nested) return null;
      elseText = text.slice(i, nested.end);
      elseEnd = nested.end;
    } else if (text[i] === "{") {
      const braced = matchBraces(text, i);
      if (!braced) return null;
      elseText = braced.content;
      elseEnd = braced.end;
    } else {
      const stmt = parseSingleStatement(text, i);
      if (!stmt) return null;
      elseText = stmt.text;
      elseEnd = stmt.end;
    }
  }
  return {
    ifIndex,
    condText,
    condStart,
    condEnd,
    thenText,
    thenEnd,
    elseText,
    elseEnd,
    elseIsIf,
    end: elseEnd ?? thenEnd,
  };
}

/** One statement starting at `start`: text (without the `;`) and the index just after it. */
function parseSingleStatement(text: string, start: number): { text: string; end: number } | null {
  let i = skipWhitespace(text, start);
  if (i >= text.length) return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (ch === inStr && text[j - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "/" && text[j + 1] === "/") {
      const nl = text.indexOf("\n", j);
      j = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[j + 1] === "*") {
      const ec = text.indexOf("*/", j + 2);
      j = ec === -1 ? text.length : ec + 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return { text: text.slice(i, j).trim(), end: j };
      depth--;
    }
    if (ch === ";" && depth === 0) return { text: text.slice(i, j).trim(), end: j + 1 };
  }
  const text_ = text.slice(i).trim();
  return text_.length > 0 ? { text: text_, end: text.length } : null;
}

// --- (c) Conditional rejection ----------------------------------------------

/**
 * Does `branch` contain a rejection that exits — `return res.status(401|403)…`,
 * `return res.sendStatus(401|403)`, a `throw`, or a status/sendStatus call
 * followed by a bare `return` before any `next(` — with no `next(` before it?
 * A bare `res.status(401)…` followed by `next()` does NOT count: execution
 * falls through and the handler runs.
 */
function branchHasExitingRejection(branch: string): boolean {
  const callRe = /(?:res\.status|res\.sendStatus)\s*\(\s*(?:401|403)\b/;
  const throwRe = /\bthrow\b/;
  const callM = callRe.exec(branch);
  const throwM = throwRe.exec(branch);
  let idx: number;
  let isThrow: boolean;
  if (callM && (!throwM || callM.index <= throwM.index)) {
    idx = callM.index;
    isThrow = false;
  } else if (throwM) {
    idx = throwM.index;
    isThrow = true;
  } else {
    return false;
  }
  // No next() before the rejection in this branch.
  if (/\bnext\s*\(/.test(branch.slice(0, idx))) return false;
  if (isThrow) return true;
  // The call itself is preceded by `return` (same statement)…
  const before = branch.slice(0, idx).replace(/\s+$/, "");
  if (/\breturn$/.test(before)) return true;
  // …or a bare `return`/`throw` follows it before any `next(`. The return
  // must start a statement (`;`, `{`, or `}` before it), so a JSON key
  // named `return` inside the rejection body does not count.
  const after = branch.slice(idx);
  const nextIdx = after.search(/\bnext\s*\(/);
  const returnIdx = after.search(/(?:;|\{|\})\s*return\b|\bthrow\b/);
  return returnIdx !== -1 && (nextIdx === -1 || returnIdx < nextIdx);
}

function bodyHasNextAfter(body: string, fromIndex: number): boolean {
  return /\bnext\s*\(/.test(body.slice(fromIndex));
}

/**
 * Evaluate one parsed `if`: does its condition contain a credential check,
 * with the rejection in the failing branch and `next()` on the pass path?
 * Returns the gate mechanism when it passes, else null.
 */
function evaluateIf(
  body: string,
  parsed: ParsedIf,
  checks: CredentialCheck[],
  refs: Array<{ text: string; mechanism: GateMechanism }>
): GateMechanism | null {
  // The credential check in this condition (comparison, verify-call, or a
  // bare credential read used as a truthiness check).
  const inCond = checks.filter((c) => c.index >= parsed.condStart && c.index < parsed.condEnd);
  let failIsThen: boolean | null = null;
  let mechanism: GateMechanism | null = null;
  if (inCond.length > 0) {
    const check = inCond[0];
    mechanism = check.mechanism;
    if (check.kind === "comparison") {
      const negated = /^\s*\(\s*!/.test(parsed.condText) || /^\s*!/.test(parsed.condText);
      const notEqual = check.operator === "!==" || check.operator === "!=";
      // `!==` → the then-branch fires when the credential does NOT match
      // (fail branch). `===` → the then-branch fires when it DOES match
      // (pass branch; the fail branch is the else). A leading `!` flips it.
      failIsThen = negated ? !notEqual : notEqual;
    } else {
      // A verify-call's truthiness means valid: then is the pass branch,
      // the else is the fail branch. A leading `!` flips it.
      const negated = /^\s*\(\s*!/.test(parsed.condText) || /^\s*!/.test(parsed.condText);
      failIsThen = negated;
    }
  } else {
    // Bare credential read as a truthiness check: the condition must BE the
    // read (possibly negated), not one term of a larger boolean expression.
    const condTrimmed = parsed.condText.trim().replace(/^\(\s*(.*)\s*\)$/, "$1").trim();
    const negated = condTrimmed.startsWith("!");
    const bare = negated ? condTrimmed.slice(1).trim() : condTrimmed;
    const ref = refs.find((r) => r.text === bare);
    if (!ref) return null;
    mechanism = ref.mechanism;
    failIsThen = negated;
  }

  const failBranch = failIsThen ? parsed.thenText : parsed.elseText;
  if (failBranch === null) return null; // no else branch to reject from
  if (parsed.elseIsIf && !failIsThen) return null; // the nested if is evaluated on its own
  if (!branchHasExitingRejection(failBranch)) return null;
  const passBranch = failIsThen ? parsed.elseText : parsed.thenText;
  const nextOnPassBranch = passBranch !== null && /\bnext\s*\(/.test(passBranch);
  const nextAfterIf = bodyHasNextAfter(body, parsed.end);
  if (!nextOnPassBranch && !nextAfterIf) return null;
  return mechanism;
}

/**
 * Evaluate a try/catch: the try block must contain a verify-call with the
 * credential, the catch block a rejection that exits, and `next()` must sit
 * in the try block after the verify call.
 */
function evaluateTryCatch(
  body: string,
  checks: CredentialCheck[]
): GateMechanism | null {
  const tryRe = /\btry\s*\{/g;
  let tm: RegExpExecArray | null;
  while ((tm = tryRe.exec(body)) !== null) {
    const braceIdx = body.indexOf("{", tm.index);
    const tryBlock = matchBraces(body, braceIdx);
    if (!tryBlock) continue;
    let i = skipWhitespace(body, tryBlock.end);
    if (body.slice(i, i + 5) !== "catch" || /[\w$]/.test(body[i + 5] ?? "")) continue;
    i = skipWhitespace(body, i + 5);
    if (body[i] === "(") {
      const parens = matchParens(body, i);
      if (!parens) continue;
      i = skipWhitespace(body, parens.end);
    }
    if (body[i] !== "{") continue;
    const catchBlock = matchBraces(body, i);
    if (!catchBlock) continue;
    const verifyInTry = checks.find(
      (c) => c.kind === "verify" && c.index > braceIdx && c.index < tryBlock.end
    );
    if (!verifyInTry) continue;
    if (!branchHasExitingRejection(catchBlock.content)) continue;
    if (!/\bnext\s*\(/.test(body.slice(verifyInTry.index, tryBlock.end))) continue;
    return verifyInTry.mechanism;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The body check and the resolution.
// ---------------------------------------------------------------------------

export interface MiddlewareCheckResult {
  passes: boolean;
  mechanism: GateMechanism;
}

/**
 * The three-part middleware body check (heuristic — see the module header):
 * (a) the body reads a credential from the request, (b) it compares or
 * verifies that value, (c) the rejection sits in the failing branch of the
 * credential check and `next()` is only reachable on the pass path.
 */
export function middlewareHasAuthCheck(body: string): MiddlewareCheckResult {
  const stripped = stripComments(body);
  const reads = findCredentialReads(stripped);
  if (reads.length === 0) return { passes: false, mechanism: "auth" };
  const aliases = findValueAliases(stripped, reads);
  const refs: Array<{ text: string; mechanism: GateMechanism }> = [
    ...reads.map((r) => ({ text: r.expr, mechanism: r.mechanism })),
    ...[...aliases.entries()].map(([text, mechanism]) => ({ text, mechanism })),
  ];
  const checks = findCredentialChecks(stripped, refs);

  // `if` shapes first (the common guard), then try/catch (jwt.verify et al).
  const ifRe = /\bif\s*\(/g;
  let im: RegExpExecArray | null;
  while ((im = ifRe.exec(stripped)) !== null) {
    const parsed = parseIf(stripped, im.index);
    if (!parsed) continue;
    const mechanism = evaluateIf(stripped, parsed, checks, refs);
    if (mechanism !== null) return { passes: true, mechanism };
  }
  const tcMechanism = evaluateTryCatch(stripped, checks);
  if (tcMechanism !== null) return { passes: true, mechanism: tcMechanism };
  return { passes: false, mechanism: "auth" };
}

/** The body of an inline middleware argument, or null when it cannot be read. */
function inlineMiddlewareBody(argText: string): string | null {
  const t = argText.trim();
  if (/^(?:async\s+)?function\b/.test(t)) {
    const openIdx = t.indexOf("{");
    if (openIdx === -1) return null;
    const braced = matchBraces(t, openIdx);
    return braced ? braced.content : null;
  }
  const arrowIdx = t.indexOf("=>");
  if (arrowIdx !== -1) {
    const after = t.slice(arrowIdx + 2).trim();
    if (after.startsWith("{")) {
      const braced = matchBraces(after, 0);
      return braced ? braced.content : null;
    }
    return after; // expression body, e.g. `(req, res, next) => next()`
  }
  return null;
}

/**
 * Resolve the middleware arguments of one route registration. Returns the
 * first middleware that passes the body check, with its name and definition
 * line — or null when none does. Imported middleware (defined in another
 * file) cannot be resolved and never passes.
 */
function resolveRouteMiddleware(
  content: string,
  routeLine: number,
  method: string,
  routePath: string
): { name: string; line: number; mechanism: GateMechanism } | null {
  const methodLower = method.toLowerCase();
  const pathEsc = routePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const routeRe = new RegExp(
    `\\b(?:app|router)\\s*\\.\\s*${methodLower}\\s*\\(\\s*['"\`]${pathEsc}['"\`]`
  );
  // Anchor at the finding's line first (the probe anchors there); fall back
  // to a whole-file search.
  const lineStart = (() => {
    let idx = 0;
    for (let n = 1; n < routeLine && idx !== -1; n++) {
      idx = content.indexOf("\n", idx);
      if (idx !== -1) idx++;
    }
    return idx === -1 ? 0 : idx;
  })();
  let m = routeRe.exec(content.slice(lineStart));
  let matchIndex = m ? lineStart + m.index : -1;
  if (matchIndex === -1) {
    m = routeRe.exec(content);
    matchIndex = m ? m.index : -1;
  }
  if (matchIndex === -1) return null;
  const argsText = extractCallArgs(content, matchIndex);
  if (!argsText) return null;
  const args = splitTopLevelArgs(argsText);
  // args[0] is the path; args[args.length - 1] is the handler; the middle
  // args are middleware candidates.
  if (args.length < 3) return null;
  const middle = args.slice(1, -1);
  for (const rawArg of middle) {
    const arg = rawArg.trim();
    if (arg.length === 0) continue;
    if (/^(?:async\s+)?function\b/.test(arg) || arg.includes("=>")) {
      const body = inlineMiddlewareBody(arg);
      if (body === null) continue;
      const checked = middlewareHasAuthCheck(body);
      if (checked.passes) {
        return { name: "(inline)", line: routeLine, mechanism: checked.mechanism };
      }
      continue;
    }
    const bare = arg.match(/^([A-Za-z_$][\w$]*)$/);
    if (!bare) continue; // member/call expression — cannot resolve
    const name = bare[1];
    if (!isDefinedInFile(name, content)) continue; // imported — invisible
    const def = findFunctionDefinition(content, name);
    if (!def) continue;
    const checked = middlewareHasAuthCheck(def.body);
    if (checked.passes) {
      return { name, line: def.line, mechanism: checked.mechanism };
    }
  }
  return null;
}

/**
 * Downgrade (never delete) no-auth findings whose route is gated by a
 * middleware that passes the body check. Returns the findings with the
 * downgrades applied and the verified gates (for the auth category scorer).
 * Pure: the input findings array is untouched.
 */
export function downgradeMiddlewareGatedNoAuthFindings(
  files: Array<{ path: string; content: string }>,
  findings: PreFlightFinding[]
): MiddlewareAuthResolution {
  const gates: VerifiedRouteGate[] = [];
  const out = findings.map((f) => {
    if (f.probe !== "API Route Auth") return f;
    if (f.severity !== "critical" && f.severity !== "high") return f;
    const m = NO_AUTH_TITLE.exec(f.title);
    if (!m) return f;
    const method = m[1];
    const routePath = m[2];
    const file = files.find((x) => x.path === f.file);
    if (!file || typeof file.content !== "string") return f;
    const resolved = resolveRouteMiddleware(file.content, f.line ?? 1, method, routePath);
    if (!resolved) return f;
    const gate: VerifiedRouteGate = {
      method,
      route: routePath,
      middlewareName: resolved.name,
      file: f.file,
      line: resolved.line,
      mechanism: resolved.mechanism,
    };
    gates.push(gate);
    return {
      ...f,
      severity: "low",
      unverified: true,
      title: `${method} ${routePath} — behind a route-level auth check; confirm the secret is set and strong`,
      evidence: `${method} ${routePath} — route middleware ${resolved.name} (${f.file}:${resolved.line}) reads a credential, verifies it, and rejects with 401/403 before next(); confirm the secret is set and strong in the deployment`,
      remediation:
        "Confirm the secret the middleware compares against is set and non-empty in the deployment (an unset secret fails open: a request with no credential passes when the expected value is undefined). Rotate the secret if it was ever committed to the repo.",
    } as PreFlightFinding;
  });
  return { findings: out, gates };
}
