// First-party probe: CSRF protection (finalread-gap-detectors-spec.md Item 2).
//
// A state-changing endpoint (POST/PUT/DELETE/PATCH) that relies on
// cookie-based session authentication and has no CSRF protection. CSRF
// protection is a CSRF token validated on the request, SameSite=lax or
// strict on the session cookie, or an Origin/Referer header check.
//
// Precision only (Richard, standing): the probe first establishes cookie
// auth — Bearer-token-only routes and unauthenticated routes are not in
// scope (the no-auth finding already covers the latter). When it cannot
// establish whether a guard exists — a guard in an imported helper it
// cannot resolve, or a session whose SameSite is a library default it
// cannot see — it routes to "Needs developer verification" (unverified:
// true + the specific question in remediation), never silently drops and
// never asserts a missing guard it cannot see. The vendored engine is
// untouched. The Cookie Security probe's cookie-flag signal is reused,
// not re-implemented: SameSite on the session cookie counts as CSRF
// mitigation.
import {
  collectRoutes,
  hasAuthSignal,
  hasSessionSignal,
  resolveRouteHandler,
  stripComments,
  callArgsText,
  findNamedFunction,
  parseFile,
  sourceTextOf,
  type CollectedRoute,
  type RouteHandlerInfo,
} from "./ast-util";
import { isTestFile } from "./vendor/lib/file-filter.js";
import type { PreFlightFinding } from "../../shared/preflight-types";
import type { ScanInputFile } from "../preflight-scan";

export const CSRF_PROBE = "CSRF Protection";

export const CSRF_QUESTION =
  "Is this route protected against cross-site request forgery (a CSRF token, SameSite on the session cookie, or an Origin check)? Point at the guard that settles it.";

// Recognised CSRF guard idioms (spec allowlist).
const CSRF_IDIOMS: RegExp[] = [
  /csurf/i,
  /csrf/i,
  /xsrf/i,
  /double[\s_-]?submit/i,
  /__Host-/i,
];

// An Origin/Referer header check on the request.
const ORIGIN_CHECK_RE =
  /(?:headers\.get\s*\(\s*['"](?:origin|referer|referrer)['"]|(?:req|request|headers)\.headers\.(?:origin|referer|referrer)|(?:req|request)\.headers\[['"](?:origin|referer|referrer)['"]\])/i;

// Middleware that is clearly not a security guard (parsing, logging, CORS,
// static files, uploads, validation). An unresolvable middleware NOT in
// this list could be a guard, so it routes to verification instead.
const KNOWN_NON_GUARD_MIDDLEWARE = new Set([
  "json",
  "urlencoded",
  "cors",
  "helmet",
  "morgan",
  "multer",
  "upload",
  "static",
  "cookieParser",
  "bodyParser",
  "requestLogger",
  "logger",
  "express.json",
  "express.urlencoded",
  "express.static",
  "validateBody",
  "validateRequest",
  "validateParams",
  "validateQuery",
  "upload.single",
  "upload.array",
  "upload.fields",
  "upload.any",
]);

// Session libraries whose session cookie defaults to SameSite=Lax (set by
// the library, not visible in the app's code). When a route's session
// comes from one of these and the code sets no explicit SameSite, the
// probe cannot establish whether SameSite mitigation applies —
// verification, not a liability (governing rule: do not flag unknowns
// as issues). express-session is deliberately NOT here: its cookie has
// no SameSite unless the code sets one, so an absent flag is a finding
// (the spec's positive control).
const LIBRARY_SESSION_RES = [
  /from\s+['"]next-auth['"]/i,
  /from\s+['"]@clerk\//i,
  /from\s+['"]auth0['"]/i,
  /from\s+['"]@auth0\//i,
  /getServerSession/i,
  /getSession/i,
  /clerkMiddleware/i,
  /withAuth/i,
];

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hasCsrfIdiom(text: string): boolean {
  if (!text) return false;
  const masked = stripComments(text);
  return CSRF_IDIOMS.some((re) => re.test(masked)) || ORIGIN_CHECK_RE.test(masked);
}

// A CSRF middleware applied globally: app/router/server .use(...) or
// .register(...) whose arguments contain a CSRF idiom, or a middleware.ts
// that does.
function hasGlobalCsrfGuard(fileMap: Map<string, string>): boolean {
  for (const [path, content] of fileMap) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    const masked = stripComments(content);
    if (/(^|\/)middleware\.[jt]sx?$/.test(path) && hasCsrfIdiom(masked)) return true;
    const useRe = /\b(?:app|router|server|fastify|hono)\.(?:use|register)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = useRe.exec(masked)) !== null) {
      const openIdx = masked.indexOf("(", m.index);
      if (openIdx === -1) continue;
      const args = callArgsText(masked, openIdx);
      if (args && hasCsrfIdiom(args)) return true;
    }
  }
  return false;
}

// A session middleware applied globally: app/router/server .use(...) whose
// arguments contain a session idiom, or a middleware.ts that does.
function hasGlobalSessionMiddleware(fileMap: Map<string, string>): boolean {
  for (const [path, content] of fileMap) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    const masked = stripComments(content);
    if (/(^|\/)middleware\.[jt]sx?$/.test(path) && hasSessionSignal(masked)) return true;
    const useRe = /\b(?:app|router|server|fastify|hono)\.(?:use|register)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = useRe.exec(masked)) !== null) {
      const openIdx = masked.indexOf("(", m.index);
      if (openIdx === -1) continue;
      const args = callArgsText(masked, openIdx);
      if (args && hasSessionSignal(args)) return true;
    }
  }
  return false;
}

// The session cookie's SameSite, from an explicit config in the code.
// Only a sameSite setting in a file that also carries a session/auth
// signal counts (a sameSite on a preferences cookie is not the session
// cookie). "absent" when no explicit setting is found.
function sessionCookieSameSite(
  fileMap: Map<string, string>
): "lax" | "strict" | "none" | "absent" {
  let found: "lax" | "strict" | "none" | null = null;
  for (const [path, content] of fileMap) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    const masked = stripComments(content);
    if (!hasSessionSignal(masked) && !hasAuthSignal(masked)) continue;
    const m =
      masked.match(/sameSite\s*[:=]\s*['"](lax|strict|none)['"]/i) ||
      masked.match(/SameSite\s*=\s*(Lax|Strict|None)/i);
    if (!m) continue;
    const v = m[1].toLowerCase() as "lax" | "strict" | "none";
    if (v === "lax" || v === "strict") return v; // a guard wins immediately
    if (!found) found = v;
  }
  return found ?? "absent";
}

// Is `name` defined as a function/variable in any scanned file?
function isDefinedInSet(name: string, fileMap: Map<string, string>): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defRe = new RegExp(
    `(?:function\\s+${esc}\\s*\\(|(?:const|let|var)\\s+${esc}\\s*=|export\\s+(?:const|let|var|async\\s+function|function)\\s+${esc}\\b|${esc}\\s*:\\s*(?:async\\s*)?function|${esc}\\s*=\\s*(?:async\\s*)?\\()`
  );
  for (const [path, content] of fileMap) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    if (defRe.test(stripComments(content))) return path;
  }
  return null;
}

// The body of a middleware defined in the scanned set, or null.
function definedMiddlewareBody(
  name: string,
  fileMap: Map<string, string>
): string | null {
  const defPath = isDefinedInSet(name, fileMap);
  if (!defPath) return null;
  const content = fileMap.get(defPath);
  if (content === undefined) return null;
  const ast = parseFile(content, defPath);
  if (!ast) return null;
  const fn = findNamedFunction(ast, name);
  return fn ? sourceTextOf(fn, content) : null;
}

function routeUsesLibrarySession(
  route: CollectedRoute,
  handlerText: string,
  fileContent: string
): boolean {
  const haystack = [route.middlewares.join(" "), handlerText, fileContent].join("\n");
  const masked = stripComments(haystack);
  return LIBRARY_SESSION_RES.some((re) => re.test(masked));
}

export function probeCsrfProtection(files: ScanInputFile[]): PreFlightFinding[] {
  try {
    return probeCsrfInner(files);
  } catch {
    // Never-throw contract: a probe failure is recorded by the caller.
    return [];
  }
}

function probeCsrfInner(files: ScanInputFile[]): PreFlightFinding[] {
  const findings: PreFlightFinding[] = [];
  const fileMap = new Map<string, string>();
  const knownPaths = new Set<string>();
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
    if (isTestFile(f.path)) continue;
    fileMap.set(f.path, f.content);
    knownPaths.add(f.path);
  }
  if (fileMap.size === 0) return findings;

  const globalSession = hasGlobalSessionMiddleware(fileMap);
  const globalCsrf = hasGlobalCsrfGuard(fileMap);
  const sameSite = sessionCookieSameSite(fileMap);

  for (const [path, content] of fileMap) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    if (
      !/\.(get|post|put|patch|delete)\s*\(/i.test(content) &&
      !/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|DELETE|PATCH)\b/.test(content)
    ) {
      continue;
    }
    const routes = collectRoutes(content, path);
    for (const route of routes) {
      const method = route.method.toUpperCase();
      if (!MUTATION_METHODS.has(method)) continue; // GET routes are not in scope
      const handler = resolveRouteHandler(route, fileMap, knownPaths);
      const mwText = route.middlewares.join(" ");
      const handlerText = handler.bodyText ?? "";
      const routeText = [mwText, handlerText].join("\n");

      // Step 1 — establish cookie auth for this route. Bearer-only and
      // unauthenticated routes are not in scope.
      const sessionInRoute = hasSessionSignal(routeText);
      const cookieAuth =
        sessionInRoute || (globalSession && hasAuthSignal(routeText));
      if (!cookieAuth) continue;

      // Step 2 — establish a CSRF guard.
      let guarded = globalCsrf;
      if (hasCsrfIdiom(routeText)) guarded = true;
      if (!guarded && (sameSite === "lax" || sameSite === "strict")) guarded = true;
      if (!guarded) {
        // A middleware that resolves to a CSRF guard in the scanned set.
        for (const mw of route.middlewares) {
          const base = mw.split(".")[0];
          const body = definedMiddlewareBody(base, fileMap);
          if (body && hasCsrfIdiom(body)) {
            guarded = true;
            break;
          }
        }
      }
      if (guarded) continue;

      // Step 3 — unknown? An unresolvable middleware that could be a
      // guard, an unparseable/unresolvable handler, or a library-managed
      // session whose default SameSite cannot be seen.
      let unknown = false;
      if (!route.parsed || !handler.resolved) unknown = true;
      if (!unknown) {
        for (const mw of route.middlewares) {
          const base = mw.split(".")[0];
          if (KNOWN_NON_GUARD_MIDDLEWARE.has(mw) || KNOWN_NON_GUARD_MIDDLEWARE.has(base)) continue;
          if (hasCsrfIdiom(mw)) continue; // a recognised guard (already handled above)
          if (isDefinedInSet(base, fileMap)) continue; // resolvable and not a CSRF guard
          unknown = true; // an imported helper the probe cannot resolve
          break;
        }
      }
      const librarySession = routeUsesLibrarySession(route, handlerText, content);
      if (!unknown && librarySession && sameSite === "absent") unknown = true;

      const label = route.path ? `${method} ${route.path}` : `${method} handler`;
      const evidence =
        `${label} at ${route.file}:${route.line} — cookie session in use; ` +
        `no CSRF token, no SameSite=strict/lax on the session cookie, no Origin check found in the scanned files.`;
      if (unknown) {
        findings.push({
          severity: "high",
          probe: CSRF_PROBE,
          title: `${label} has no CSRF protection`,
          file: route.file,
          line: route.line,
          evidence:
            librarySession && sameSite === "absent"
              ? `${evidence} The session comes from a library (NextAuth/Clerk/Auth0) whose default SameSite cannot be established from the code.`
              : `${evidence} The probe cannot establish whether a guard exists (an unresolvable helper or handler).`,
          remediation: CSRF_QUESTION,
          unverified: true,
          owasp: ["A01"],
          cwe: "CWE-352",
        });
        continue;
      }
      findings.push({
        severity: "high",
        probe: CSRF_PROBE,
        title: `${label} has no CSRF protection`,
        file: route.file,
        line: route.line,
        evidence,
        remediation:
          "Add CSRF protection to this route: validate a CSRF token (e.g. csurf middleware, or a double-submit cookie + header/body token check), set SameSite=lax or strict on the session cookie, or check the Origin/Referer header on state-changing requests.",
        owasp: ["A01"],
        cwe: "CWE-352",
      });
    }
  }
  return findings;
}
