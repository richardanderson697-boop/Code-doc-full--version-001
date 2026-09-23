// Express 4 does not forward an async handler's rejection to the error
// middleware: Node terminates the process instead. asyncRoute closes that, but
// it is defence in depth, so removing it from a route whose known throw is
// already contained breaks no behavioural test. That is exactly how the
// protection would get deleted and stay deleted.
//
// So assert the invariant directly: every async handler in every router is
// wrapped. This is the only test that fails if someone unwraps one.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROUTES_DIR = path.join(process.cwd(), "server", "routes");

function routeFiles(): string[] {
  return fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(ROUTES_DIR, f));
}

// router.<verb>("<path>", <what follows>
const HANDLER_RE = /router\.(get|post|put|delete|patch|all)\(\s*("[^"]+")\s*,\s*([\s\S]{0,24})/g;

/**
 * True when what follows the route path is an async handler that is not
 * wrapped. Leading parens are stripped first: `(async (req, res) => …)` is
 * still an unwrapped async handler, and an earlier version of this detector
 * read the `(` and concluded the handler was not async at all, which let a
 * real unwrapping pass unnoticed.
 */
function isUnwrappedAsync(following: string): boolean {
  if (/^\s*asyncRoute\s*\(/.test(following)) return false;
  return /^[\s(]*async\s*\(/.test(following);
}

describe("async route handlers are wrapped", () => {
  it("finds route files to check", () => {
    expect(routeFiles().length).toBeGreaterThan(0);
  });

  it("wraps every async handler in asyncRoute", () => {
    const unwrapped: string[] = [];
    for (const file of routeFiles()) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(HANDLER_RE)) {
        const [, verb, routePath, following] = m;
        if (isUnwrappedAsync(following)) {
          unwrapped.push(`${path.basename(file)} ${verb.toUpperCase()} ${routePath}`);
        }
      }
    }
    expect(unwrapped).toEqual([]);
  });

  it("imports asyncRoute in every file that registers one", () => {
    for (const file of routeFiles()) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes("asyncRoute(")) {
        expect(src).toMatch(/import \{ asyncRoute \} from "\.\.\/async-route"/);
      }
    }
  });

  // Guards the detector itself. A detector that matches nothing would make the
  // test above pass no matter what the routers look like, so each shape it has
  // to classify gets its own case.
  const detect = (sample: string) =>
    [...sample.matchAll(HANDLER_RE)].filter((m) => isUnwrappedAsync(m[3])).length;

  it("flags a bare async handler", () => {
    expect(detect(`router.post("/api/x", async (req, res) => { res.end(); });`)).toBe(1);
  });

  it("flags an async handler wrapped only in parentheses", () => {
    // Exactly what removing asyncRoute leaves behind.
    expect(detect(`router.post("/api/x", (async (req, res) => { res.end(); }));`)).toBe(1);
  });

  it("does not flag a wrapped handler", () => {
    expect(detect(`router.post("/api/x", asyncRoute(async (req, res) => { res.end(); }));`)).toBe(0);
  });

  it("does not flag a synchronous handler", () => {
    expect(detect(`router.get("/api/x", (req, res) => { res.end(); });`)).toBe(0);
  });
});
