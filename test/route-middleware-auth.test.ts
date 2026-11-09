// Route-middleware auth resolution tests (finalread-route-middleware-auth-spec.md).
//
// The vendored API-route-auth probe decides "has auth" from a fixed
// middleware-NAME allowlist and only examines the last route argument (the
// handler). This suite proves the score-layer resolution downgrades the
// finding (never deletes it) when a route's middleware actually verifies the
// caller — behavior, not names — and keeps it for every dangerous shape the
// heuristic cannot prove safe.
//
// Harness: the vendored probe runs on the fixture files (its observable
// findings are the input), then computeDeterministicAssessment applies the
// resolution. That is also the behavioral parity check for the first-party
// copies of the vendored helpers: the probe and the resolution agree on the
// fixtures through the probe's own findings.
import { describe, it, expect } from "vitest";
import fs from "fs";
import { probeAPIRouteAuth } from "../server/preflight/vendor/lib/probes/auth.js";
import { computeDeterministicAssessment } from "../server/deterministic-score";
import {
  extractCallArgs,
  splitTopLevelArgs,
  isDefinedInFile,
  extractFunctionBody,
  middlewareHasAuthCheck,
} from "../server/route-middleware-auth";
import type { PreFlightReport, PreFlightFinding } from "../shared/preflight-types";
import type { WorkspaceFile } from "../server/workspace";

function wf(path: string, content: string): WorkspaceFile {
  return { path, content, lineCount: content.split("\n").length } as WorkspaceFile;
}

function emptyPreflight(findings: PreFlightFinding[]): PreFlightReport {
  return {
    engine: "PreFlight",
    probeCount: 113,
    filesScanned: 1,
    filesSkipped: [],
    score: 100,
    counts: {},
    findings,
    probeFailures: [],
    failed: null,
  } as PreFlightReport;
}

const RESCAN_TEST = "/home/hatch/workspace/finalread-rescan-test";

function loadTree(dir: string): WorkspaceFile[] {
  return ["package.json", "README.md", "server.js"].map((p) =>
    wf(p, fs.readFileSync(`${dir}/${p}`, "utf8"))
  );
}

/** Run the vendored probe, then the assessment, on a file set. */
function assess(files: WorkspaceFile[]) {
  const probeFindings = probeAPIRouteAuth(files as any) as PreFlightFinding[];
  const a = computeDeterministicAssessment(files, emptyPreflight(probeFindings));
  return { probeFindings, a };
}

const PKG = JSON.stringify({ name: "test", version: "1.0.0", dependencies: { express: "^4.18.2" } });
const NEUTRAL_README = "# Test App\n\nA tiny Express app.\n";

/** Minimal tree for the variant fixtures: package.json + neutral README + one server.js. */
function assessServerJs(serverJs: string) {
  return assess([wf("package.json", PKG), wf("README.md", NEUTRAL_README), wf("server.js", serverJs)]);
}

function noAuthFindings(a: ReturnType<typeof computeDeterministicAssessment>): PreFlightFinding[] {
  return a.calibratedPreflightFindings.filter((f) => /without auth check/i.test(f.title));
}

const ADMIN_HANDLER = `  res.json([{ id: 1, email: 'admin@example.com' }]);`;

function serverWith(middlewareDef: string, routeArgs: string): string {
  return `const express = require('express');
const app = express();
app.use(express.json());
${middlewareDef}
app.get('/api/status', (req, res) => res.json({ ok: true }));
app.get('/api/admin/users', ${routeArgs}, (req, res) => {
${ADMIN_HANDLER}
});
app.listen(3000, () => console.log('listening on 3000'));
`;
}

const REQUIRE_API_KEY = `function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`;

describe("live re-scan trees (v1 / v2)", () => {
  it("v1 keeps the critical no-auth finding; auth category 0 (README declares no-auth)", () => {
    const { probeFindings, a } = assess(loadTree(`${RESCAN_TEST}/v1`));
    expect(probeFindings).toHaveLength(1);
    expect(probeFindings[0].title).toBe("GET /api/admin/users without auth check");
    expect(probeFindings[0].severity).toBe("critical");
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe("critical");
    expect(kept[0].title).toBe("GET /api/admin/users without auth check");
    expect(kept[0].unverified).not.toBe(true);
    expect(a.categories.authentication.score).toBe(0);
    expect(a.categories.authentication.applicable).toBe(false);
  });

  it("v2 downgrades to needs-verification; auth category 3 with route-level wording", () => {
    const { probeFindings, a } = assess(loadTree(`${RESCAN_TEST}/v2`));
    // The probe still fires (requireApiKey is not in its name allowlist) —
    // the resolution is what changes the outcome.
    expect(probeFindings).toHaveLength(1);
    expect(probeFindings[0].title).toBe("GET /api/admin/users without auth check");
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(0);
    const downgraded = a.calibratedPreflightFindings.filter((f) =>
      /behind a route-level auth check/.test(f.title)
    );
    expect(downgraded).toHaveLength(1);
    expect(downgraded[0].severity).toBe("low");
    expect(downgraded[0].unverified).toBe(true);
    expect(downgraded[0].title).toBe(
      "GET /api/admin/users — behind a route-level auth check; confirm the secret is set and strong"
    );
    expect(downgraded[0].evidence).toMatch(/requireApiKey/);
    expect(downgraded[0].evidence).toMatch(/server\.js:6/);
    expect(downgraded[0].remediation).toMatch(/unset secret fails open/);
    // No other finding changes: the probe emitted exactly one finding and
    // it is the downgraded one.
    expect(a.calibratedPreflightFindings).toHaveLength(1);
    expect(a.categories.authentication.score).toBe(3);
    expect(a.categories.authentication.note).toBe("route-level-gate");
    expect(a.categories.authentication.evidence.join(" ")).toMatch(
      /route-level API-key check on GET \/api\/admin\/users \(requireApiKey, server\.js:6\); no user accounts or sessions/
    );
  });
});

describe("downgrade variants (must downgrade)", () => {
  it("inline middleware arg doing the header compare + 401 + next() → downgraded", () => {
    const { a } = assessServerJs(
      serverWith(
        "",
        `(req, res, next) => {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`
      )
    );
    expect(noAuthFindings(a)).toHaveLength(0);
    expect(a.calibratedPreflightFindings.filter((f) => /behind a route-level auth check/.test(f.title))).toHaveLength(1);
    expect(a.categories.authentication.score).toBe(3);
  });

  it("two middlewares, first a no-op, second the real check → downgraded", () => {
    const { a } = assessServerJs(
      serverWith(REQUIRE_API_KEY, `(req, res, next) => next(), requireApiKey`)
    );
    expect(noAuthFindings(a)).toHaveLength(0);
    expect(a.calibratedPreflightFindings.filter((f) => /behind a route-level auth check/.test(f.title))).toHaveLength(1);
  });

  it("arrow-form definition (const requireApiKey = (…) => {…}) → downgraded", () => {
    const { a } = assessServerJs(
      serverWith(
        `const requireApiKey = (req, res, next) => {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
};`,
        `requireApiKey`
      )
    );
    expect(noAuthFindings(a)).toHaveLength(0);
    expect(a.calibratedPreflightFindings.filter((f) => /behind a route-level auth check/.test(f.title))).toHaveLength(1);
  });

  it("value alias (const key = req.headers[…]; if (key !== …)) → downgraded", () => {
    const { a } = assessServerJs(
      serverWith(
        `function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`,
        `requireApiKey`
      )
    );
    expect(noAuthFindings(a)).toHaveLength(0);
    expect(a.calibratedPreflightFindings.filter((f) => /behind a route-level auth check/.test(f.title))).toHaveLength(1);
  });

  it("verify-call in try/catch (bcrypt.compare) behind a custom name → downgraded", () => {
    const { a } = assessServerJs(
      serverWith(
        `async function checkKey(req, res, next) {
  try {
    const ok = await bcrypt.compare(req.headers['x-api-key'], storedHash);
    if (!ok) throw new Error('bad key');
    next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}`,
        `checkKey`
      )
    );
    expect(noAuthFindings(a)).toHaveLength(0);
    const downgraded = a.calibratedPreflightFindings.filter((f) => /behind a route-level auth check/.test(f.title));
    expect(downgraded).toHaveLength(1);
    expect(a.categories.authentication.evidence.join(" ")).toMatch(/route-level API-key check/);
  });

  it("verify-call in a negated if condition (bcrypt.compare) → downgraded", () => {
    const { a } = assessServerJs(
      serverWith(
        `async function checkKey(req, res, next) {
  if (!(await bcrypt.compare(req.headers['x-api-key'], storedHash))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`,
        `checkKey`
      )
    );
    expect(noAuthFindings(a)).toHaveLength(0);
    expect(a.calibratedPreflightFindings.filter((f) => /behind a route-level auth check/.test(f.title))).toHaveLength(1);
  });

  it("route with a middleware the probe already recognizes (requireAuth) → no finding at all", () => {
    const { probeFindings, a } = assessServerJs(
      serverWith(
        `function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`,
        `requireAuth`
      )
    );
    expect(probeFindings).toHaveLength(0);
    expect(a.calibratedPreflightFindings).toHaveLength(0);
  });
});

describe("must-keep (dangerous false negatives — the check is a heuristic)", () => {
  it("inverted logic: 401 when the key MATCHES → kept, critical", () => {
    const { a } = assessServerJs(
      serverWith(
        `function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] === process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`,
        `requireApiKey`
      )
    );
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe("critical");
  });

  it("401 without return, then next() anyway → kept, critical", () => {
    const { a } = assessServerJs(
      serverWith(
        `function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`,
        `requireApiKey`
      )
    );
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe("critical");
  });

  it("comparison whose result is never used → kept, critical", () => {
    const { a } = assessServerJs(
      serverWith(
        `function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  const valid = key === process.env.ADMIN_API_KEY;
  if (req.path === '/admin') {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`,
        `requireApiKey`
      )
    );
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe("critical");
  });

  it("rejection inside an unrelated branch → kept, critical", () => {
    const { a } = assessServerJs(
      serverWith(
        `function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.ADMIN_API_KEY) {
    console.log('bad key');
  }
  if (req.query.debug === '1') {
    return res.status(401).json({ error: 'no debug' });
  }
  next();
}`,
        `requireApiKey`
      )
    );
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe("critical");
  });

  it("compares but never rejects → kept, critical", () => {
    const { a } = assessServerJs(
      serverWith(
        `function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
    console.log('bad key');
  }
  next();
}`,
        `requireApiKey`
      )
    );
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe("critical");
  });

  it("always 401s without comparing → kept, critical", () => {
    const { a } = assessServerJs(
      serverWith(
        `function blockAll(req, res, next) {
  return res.status(401).json({ error: 'unauthorized' });
}`,
        `blockAll`
      )
    );
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe("critical");
  });

  it("middleware imported from another file → kept, critical", () => {
    const { a } = assessServerJs(
      serverWith(
        `const { requireApiKey } = require('./auth');`,
        `requireApiKey`
      )
    );
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe("critical");
  });

  it("non-sensitive route with no middleware → no finding either way", () => {
    const { a } = assess([
      wf("package.json", PKG),
      wf("README.md", NEUTRAL_README),
      wf(
        "server.js",
        `const express = require('express');
const app = express();
app.get('/api/status', (req, res) => res.json({ ok: true }));
app.listen(3000);
`
      ),
    ]);
    expect(a.calibratedPreflightFindings).toHaveLength(0);
  });
});

describe("known-kept (safe direction, named, not a failure)", () => {
  it("variable indirection (const ok = <comparison>; if (!ok)) → kept", () => {
    const { a } = assessServerJs(
      serverWith(
        `function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  const ok = key === process.env.ADMIN_API_KEY;
  if (!ok) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`,
        `requireApiKey`
      )
    );
    const kept = noAuthFindings(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].severity).toBe("critical");
  });
});

describe("first-party copies of the vendored helpers (unit)", () => {
  it("extractCallArgs + splitTopLevelArgs split a route call at top-level commas", () => {
    const src = `app.get('/api/admin/users', requireApiKey, (req, res) => { res.json({ a: 1, b: 2 }); });`;
    const argsText = extractCallArgs(src, src.indexOf("app.get"));
    expect(argsText).toBe(`'/api/admin/users', requireApiKey, (req, res) => { res.json({ a: 1, b: 2 }); }`);
    const args = splitTopLevelArgs(argsText!);
    expect(args.map((a) => a.trim())).toEqual([
      `'/api/admin/users'`,
      `requireApiKey`,
      `(req, res) => { res.json({ a: 1, b: 2 }); }`,
    ]);
  });

  it("extractCallArgs returns null when the call never closes", () => {
    expect(extractCallArgs(`app.get('/x', handler`, 0)).toBeNull();
  });

  it("isDefinedInFile recognizes the definition shapes and rejects imports", () => {
    const src = `function a(req, res, next) {}
const b = function (req, res, next) {};
const c = (req, res, next) => {};
d = (req, res, next) => {};
const { e } = require('./auth');
import { f } from './auth';`;
    expect(isDefinedInFile("a", src)).toBe(true);
    expect(isDefinedInFile("b", src)).toBe(true);
    expect(isDefinedInFile("c", src)).toBe(true);
    expect(isDefinedInFile("d", src)).toBe(true);
    expect(isDefinedInFile("e", src)).toBe(false);
    expect(isDefinedInFile("f", src)).toBe(false);
    expect(isDefinedInFile("missing", src)).toBe(false);
  });

  it("extractFunctionBody returns the brace-balanced body", () => {
    const src = `function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}`;
    const body = extractFunctionBody(src, "requireApiKey");
    expect(body).toContain(`req.headers['x-api-key']`);
    expect(body).toContain(`next();`);
    expect(extractFunctionBody(src, "nope")).toBeNull();
  });

  it("middlewareHasAuthCheck passes the v2 shape and fails the dangerous shapes", () => {
    const body = extractFunctionBody(REQUIRE_API_KEY, "requireApiKey");
    expect(body).not.toBeNull();
    expect(middlewareHasAuthCheck(body!).passes).toBe(true);
    expect(middlewareHasAuthCheck(body!).mechanism).toBe("API-key");
    expect(
      middlewareHasAuthCheck(`if (req.headers['x-api-key'] === process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();`).passes
    ).toBe(false);
    expect(
      middlewareHasAuthCheck(`if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ error: 'unauthorized' });
  }
  next();`).passes
    ).toBe(false);
  });
});
