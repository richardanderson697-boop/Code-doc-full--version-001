// First-party probe: rate limiting (finalread-gap-detectors-spec.md Item 1).
//
// A sensitive route with no rate-limit guard. A sensitive route is (a) an
// auth endpoint — login, signup/register, password reset / forgot-password,
// OTP/verify — or (b) an unauthenticated public mutation endpoint
// (POST/PUT/DELETE/PATCH with no recognised auth check, reusing the auth
// probe's hasAuth shape). A rate-limit guard is a global or per-route
// rate-limit middleware, an in-handler check, a CAPTCHA, an account
// lockout, or a platform rate-limit config that names the route.
//
// Precision only (Richard, standing): the probe flags a missing guard it
// can establish is missing. When it cannot establish whether a guard
// exists — a platform config that does not name the route, a guard-like
// helper it does not recognise, or a handler it cannot resolve — it routes
// to "Needs developer verification" (unverified: true + the specific
// question in remediation), never silently drops and never asserts a
// missing guard it cannot see. The vendored engine is untouched.
import {
  collectRoutes,
  hasAuthSignal,
  resolveRouteHandler,
  stripComments,
  callArgsText,
  type CollectedRoute,
  type RouteHandlerInfo,
} from "./ast-util";
import { isTestFile } from "./vendor/lib/file-filter.js";
import type { PreFlightFinding } from "../../shared/preflight-types";
import type { ScanInputFile } from "../preflight-scan";

export const RATE_LIMIT_PROBE = "Rate Limit";

export const RATE_LIMIT_QUESTION =
  "Is this login route rate-limited outside this file (platform config, CDN/WAF, or a helper the scanner does not recognise)? Point at the config or call that settles it.";

export const RATE_LIMIT_API_QUESTION =
  "Is this route rate-limited outside this file (platform config, CDN/WAF, or a helper the scanner does not recognise)? Point at the config or call that settles it.";

// Recognised rate-limit guard idioms (spec allowlist). A 429 response and
// an account-lockout counter count as guards; a CAPTCHA counts as a
// rate-limiting-equivalent control for brute force.
const RATE_LIMIT_IDIOMS: RegExp[] = [
  /rate[\s_-]?limit/i,
  /rate[\s_-]?limiter[\s_-]?flexible/i,
  /limiter/i,
  /throttle/i,
  /slowDown/i,
  /checkRateLimit/i,
  /isRateLimited/i,
  /tooManyRequests/i,
  /status\s*\(\s*429/i,
  /status\s*:\s*429/i,
  /statusCode\s*[:=]\s*429/i,
  /lockout/i,
  /failedAttempts/i,
  /maxAttempts/i,
  /lockedUntil/i,
  /captcha/i,
  /turnstile/i,
];

// A guard-like identifier the probe does not recognise (a custom throttle
// helper, an unfamiliar limiter name). Present but unrecognised means the
// probe cannot establish whether the route is guarded — verification,
// not a liability.
const GUARD_LIKE_STEM = /limit|throttl|rate|quota|lockout|captcha/i;

function hasRecognisedGuard(text: string): boolean {
  if (!text) return false;
  const masked = stripComments(text);
  return RATE_LIMIT_IDIOMS.some((re) => re.test(masked));
}

// Middleware-chain identifiers: any guard-stem name is guard-like (a
// middleware named checkLimit is plausibly a rate limiter).
function hasGuardLikeUnknownMiddleware(text: string): boolean {
  if (!text) return false;
  const masked = stripComments(text);
  const ids = masked.match(/[A-Za-z_$][\w$]*/g) || [];
  for (const id of ids) {
    if (!GUARD_LIKE_STEM.test(id)) continue;
    if (RATE_LIMIT_IDIOMS.some((re) => re.test(id))) continue;
    return true;
  }
  return false;
}

// Handler-body calls: only a BARE identifier call is guard-like (a helper
// the route calls, e.g. checkLimit(req)). A member call such as
// db.select().limit(1) is a query-builder limit, not a rate limiter —
// the lookbehind excludes identifiers preceded by "." (or a word char).
function hasGuardLikeUnknownCall(text: string): boolean {
  if (!text) return false;
  const masked = stripComments(text);
  const callRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(masked)) !== null) {
    const id = m[1];
    if (!GUARD_LIKE_STEM.test(id)) continue;
    if (RATE_LIMIT_IDIOMS.some((re) => re.test(id))) continue;
    return true;
  }
  return false;
}

// Auth-endpoint path segments (mutation methods only — a GET login page is
// not a brute-force target).
const AUTH_PATH_RE =
  /\/(login|log-in|signin|sign-in|signup|sign-up|register|registration|forgot-password|forgot|reset-password|reset|otp|verify|auth)\b/i;

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// A rate-limit middleware applied globally: app/router/server/fastify
// .use(...) or .register(...) whose arguments contain a recognised
// rate-limit idiom, or a middleware.ts file that rate-limits.
function hasGlobalRateLimit(fileMap: Map<string, string>): boolean {
  for (const [path, content] of fileMap) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    const masked = stripComments(content);
    if (/(^|\/)middleware\.[jt]sx?$/.test(path) && hasRecognisedGuard(masked)) return true;
    const useRe = /\b(?:app|router|server|fastify|hono)\.(?:use|register)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = useRe.exec(masked)) !== null) {
      const openIdx = masked.indexOf("(", m.index);
      if (openIdx === -1) continue;
      const args = callArgsText(masked, openIdx);
      if (args && hasRecognisedGuard(args)) return true;
    }
  }
  return false;
}

interface PlatformConfig {
  file: string;
  content: string;
}

// A platform rate-limit config in the repo (vercel.json, wrangler.toml,
// netlify.toml) that contains a rate-limit rule.
function findPlatformRateLimitConfig(
  fileMap: Map<string, string>
): PlatformConfig | null {
  for (const [path, content] of fileMap) {
    if (!/(^|\/)(vercel\.json|wrangler\.toml|netlify\.toml)$/.test(path)) continue;
    if (hasRecognisedGuard(content)) return { file: path, content };
  }
  return null;
}

// Does the platform config name this route (exact path, or a wildcard
// prefix that covers it, e.g. "/api/*")?
function platformNamesRoute(config: string, routePath: string): boolean {
  if (!routePath) return false;
  if (config.includes(routePath)) return true;
  for (const m of config.matchAll(/["']([^"']*\/\*)["']/g)) {
    const prefix = m[1].replace(/\*$/, "");
    if (routePath.startsWith(prefix)) return true;
  }
  return false;
}

type GuardStatus = "guarded" | "unguarded" | "unknown";

function rateLimitStatus(
  route: CollectedRoute,
  handler: RouteHandlerInfo,
  globalGuard: boolean,
  platform: PlatformConfig | null
): GuardStatus {
  if (globalGuard) return "guarded";
  const mwText = route.middlewares.join(" ");
  if (hasRecognisedGuard(mwText)) return "guarded";
  // A platform config that names the route is a guard even when the
  // handler cannot be resolved.
  if (platform && platformNamesRoute(platform.content, route.path)) return "guarded";
  let unknown = false;
  if (hasGuardLikeUnknownMiddleware(mwText)) unknown = true;
  if (!route.parsed || !handler.resolved) unknown = true;
  if (handler.bodyText) {
    if (hasRecognisedGuard(handler.bodyText)) return "guarded";
    if (hasGuardLikeUnknownCall(handler.bodyText)) unknown = true;
  }
  if (platform) unknown = true; // a rate-limit config exists but does not name this route
  return unknown ? "unknown" : "unguarded";
}

export function probeRateLimit(files: ScanInputFile[]): PreFlightFinding[] {
  try {
    return probeRateLimitInner(files);
  } catch {
    // Never-throw contract: a probe failure is recorded by the caller.
    return [];
  }
}

function probeRateLimitInner(files: ScanInputFile[]): PreFlightFinding[] {
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

  const globalGuard = hasGlobalRateLimit(fileMap);
  const platform = findPlatformRateLimitConfig(fileMap);

  for (const [path, content] of fileMap) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    // Cheap pre-filter: a file that mentions neither a route registration
    // nor a method export cannot contain a route.
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
      const authHaystack = [route.middlewares.join(" "), handler.bodyText ?? ""].join("\n");
      const isAuthEndpoint = !!route.path && AUTH_PATH_RE.test(route.path);
      // An authenticated mutation is not in scope (the spec covers auth
      // endpoints and unauthenticated public mutations only).
      if (!isAuthEndpoint && hasAuthSignal(authHaystack)) continue;

      const status = rateLimitStatus(route, handler, globalGuard, platform);
      if (status === "guarded") continue;

      const label = route.path ? `${method} ${route.path}` : `${method} handler`;
      const evidence =
        `${label} at ${route.file}:${route.line} — no rate-limit middleware, ` +
        `per-route limiter, or in-handler check found in the scanned files.`;
      if (status === "unknown") {
        findings.push({
          severity: "high",
          probe: RATE_LIMIT_PROBE,
          title: `${label} has no rate-limit guard`,
          file: route.file,
          line: route.line,
          evidence:
            platform && !platformNamesRoute(platform.content, route.path)
              ? `${evidence} A platform rate-limit config exists (${platform.file}) but does not name this route, so the probe cannot establish whether the route is rate-limited.`
              : `${evidence} The probe cannot establish whether a guard exists (an unrecognised helper or an unresolvable handler).`,
          remediation: isAuthEndpoint ? RATE_LIMIT_QUESTION : RATE_LIMIT_API_QUESTION,
          unverified: true,
          owasp: ["A07"],
          cwe: "CWE-307",
        });
        continue;
      }
      findings.push({
        severity: "high",
        probe: RATE_LIMIT_PROBE,
        title: `${label} has no rate-limit guard`,
        file: route.file,
        line: route.line,
        evidence,
        remediation:
          "Add a rate limiter to this route (e.g. express-rate-limit applied globally or per-route, or an in-handler check with a 429 response). If the route is already rate-limited outside this code (platform config, CDN/WAF), point at that config.",
        owasp: ["A07"],
        cwe: "CWE-307",
      });
    }
  }
  return findings;
}
