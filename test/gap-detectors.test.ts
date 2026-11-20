// Gap detectors — rate limiting, CSRF, debug mode, logging secrets,
// file-upload validation (finalread-gap-detectors-spec.md, APPROVED
// 2026-11-20).
//
// Five first-party TypeScript probes (not Opengrep rules, not vendored
// edits). Each item has three controls: a positive control (must flag),
// a negative control (must not flag), and a verification-bucket case
// (must route to "Needs developer verification" with its specific
// question, not a liability and not silence). The wiring tests drive
// runPreFlightScan and the deterministic score / report builder, and
// assert the five PROBE_CATEGORY_MAP entries.
import { describe, it, expect } from "vitest";
import {
  probeRateLimit,
  RATE_LIMIT_PROBE,
  RATE_LIMIT_QUESTION,
} from "../server/preflight/rate-limit-probe";
import {
  probeCsrfProtection,
  CSRF_PROBE,
  CSRF_QUESTION,
} from "../server/preflight/csrf-probe";
import {
  probeDebugMode,
  DEBUG_MODE_PROBE,
  DEBUG_ENV_QUESTION,
} from "../server/preflight/debug-mode-probe";
import {
  probeSecretLogging,
  SECRET_LOGGING_PROBE,
  SECRET_LOGGING_QUESTION,
} from "../server/preflight/secret-logging-probe";
import {
  probeFileUploadValidation,
  FILE_UPLOAD_PROBE,
  FILE_UPLOAD_QUESTION,
  FILE_UPLOAD_WEBROOT_QUESTION,
} from "../server/preflight/file-upload-probe";
import { runPreFlightScan } from "../server/preflight-scan";
import { scan } from "../server/preflight/vendor/lib/cockpit-scan.js";
import {
  computeDeterministicAssessment,
  PROBE_CATEGORY_MAP,
} from "../server/deterministic-score";
import { buildFinalReadReport } from "../shared/finalread-report";
import type { PreFlightFinding, PreFlightReport } from "../shared/preflight-types";
import type { WorkspaceFile } from "../server/workspace";

const f = (path: string, content: string) => ({ path, content });
const byProbe = (findings: PreFlightFinding[], probe: string) =>
  findings.filter((x) => x.probe === probe);
const titles = (r: { findings: { title: string }[] }) => r.findings.map((x) => x.title);
const hasTitle = (r: { findings: { title: string }[] }, needle: string) =>
  titles(r).some((t) => t.includes(needle));

// ---------------------------------------------------------------------------
// Item 1 — Rate limiting
// ---------------------------------------------------------------------------

const LOGIN_NO_GUARD = `import express from 'express'
const app = express()
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body
  if (email === 'a@b.c' && password === 'secret') return res.json({ ok: true })
  return res.status(401).json({ error: 'bad credentials' })
})
export default app
`;

const LOGIN_GLOBAL_LIMIT = `import express from 'express'
import rateLimit from 'express-rate-limit'
const app = express()
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 })
app.use(limiter)
app.post('/api/auth/login', (req, res) => {
  return res.json({ ok: true })
})
export default app
`;

const LOGIN_ROUTE_LIMIT = `import express from 'express'
import rateLimit from 'express-rate-limit'
const app = express()
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 })
app.post('/api/auth/login', loginLimiter, (req, res) => {
  return res.json({ ok: true })
})
export default app
`;

const LOGIN_CAPTCHA = `import express from 'express'
const app = express()
async function verifyCaptcha(token) {
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', { method: 'POST', body: token })
  return res.ok
}
app.post('/api/auth/login', async (req, res) => {
  const ok = await verifyCaptcha(req.body.captchaToken)
  if (!ok) return res.status(400).json({ error: 'captcha failed' })
  return res.json({ ok: true })
})
export default app
`;

const LOGIN_PLATFORM_CONFIG = `import express from 'express'
const app = express()
app.post('/api/auth/login', (req, res) => {
  return res.json({ ok: true })
})
export default app
`;
const VERCEL_RATE_LIMIT = JSON.stringify({ rateLimit: { windowMs: 60000, max: 100 } });

const LOGIN_CHECK_LIMIT = `import express from 'express'
import { checkLimit } from './guards'
const app = express()
app.post('/api/auth/login', checkLimit, (req, res) => {
  return res.json({ ok: true })
})
export default app
`;

const PUBLIC_MUTATION = `import express from 'express'
const app = express()
app.post('/api/contact', (req, res) => {
  return res.json({ ok: true })
})
export default app
`;

const AUTHED_MUTATION = `import express from 'express'
import { requireAuth } from './auth'
const app = express()
app.post('/api/settings', requireAuth, (req, res) => {
  return res.json({ ok: true })
})
export default app
`;

describe("Item 1 — Rate limiting", () => {
  it("flags an Express POST /api/auth/login route with no rate-limit guard", () => {
    const out = probeRateLimit([f("server/routes/auth.ts", LOGIN_NO_GUARD)]);
    expect(out).toHaveLength(1);
    expect(out[0].probe).toBe(RATE_LIMIT_PROBE);
    expect(out[0].severity).toBe("high");
    expect(out[0].title).toBe("POST /api/auth/login has no rate-limit guard");
    expect(out[0].file).toBe("server/routes/auth.ts");
    expect(out[0].unverified).toBeUndefined();
    expect(out[0].cwe).toBe("CWE-307");
    expect(out[0].owasp).toEqual(["A07"]);
  });

  it("does NOT flag the same login route with a global express-rate-limit", () => {
    expect(probeRateLimit([f("server/routes/auth.ts", LOGIN_GLOBAL_LIMIT)])).toHaveLength(0);
  });

  it("does NOT flag the same login route with a per-route limiter", () => {
    expect(probeRateLimit([f("server/routes/auth.ts", LOGIN_ROUTE_LIMIT)])).toHaveLength(0);
  });

  it("does NOT flag a login route behind a CAPTCHA check", () => {
    expect(probeRateLimit([f("server/routes/auth.ts", LOGIN_CAPTCHA)])).toHaveLength(0);
  });

  it("flags an unauthenticated public mutation endpoint (POST /api/contact)", () => {
    const out = probeRateLimit([f("server/routes/contact.ts", PUBLIC_MUTATION)]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("POST /api/contact has no rate-limit guard");
    expect(out[0].unverified).toBeUndefined();
  });

  it("does NOT flag an authenticated mutation (requireAuth in the chain)", () => {
    expect(probeRateLimit([f("server/routes/settings.ts", AUTHED_MUTATION)])).toHaveLength(0);
  });

  it("routes to verification when a platform rate-limit config exists but does not name the route", () => {
    const out = probeRateLimit([
      f("server/routes/auth.ts", LOGIN_PLATFORM_CONFIG),
      f("vercel.json", VERCEL_RATE_LIMIT),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(RATE_LIMIT_QUESTION);
  });

  it("routes to verification when an unrecognised checkLimit helper guards the route", () => {
    const out = probeRateLimit([f("server/routes/auth.ts", LOGIN_CHECK_LIMIT)]);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(RATE_LIMIT_QUESTION);
  });
});

// ---------------------------------------------------------------------------
// Item 2 — CSRF protection
// ---------------------------------------------------------------------------

const CSRF_POSITIVE = `import express from 'express'
import session from 'express-session'
const app = express()
app.use(session({ secret: 's3cret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: true } }))
app.post('/api/account/delete', (req, res) => {
  const userId = req.session.userId
  if (!userId) return res.status(401).json({ error: 'unauthorized' })
  return res.json({ ok: true })
})
export default app
`;

const CSRF_TOKEN_GLOBAL = `import express from 'express'
import session from 'express-session'
import csrf from 'csurf'
const app = express()
app.use(session({ secret: 's3cret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: true } }))
app.use(csrf())
app.post('/api/account/delete', (req, res) => {
  const userId = req.session.userId
  if (!userId) return res.status(401).json({ error: 'unauthorized' })
  return res.json({ ok: true })
})
export default app
`;

const CSRF_TOKEN_ROUTE = `import express from 'express'
import session from 'express-session'
import csrf from 'csurf'
const app = express()
app.use(session({ secret: 's3cret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: true } }))
app.post('/api/account/delete', csrf(), (req, res) => {
  const userId = req.session.userId
  if (!userId) return res.status(401).json({ error: 'unauthorized' })
  return res.json({ ok: true })
})
export default app
`;

const CSRF_SAMESITE = `import express from 'express'
import session from 'express-session'
const app = express()
app.use(session({ secret: 's3cret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: true, sameSite: 'strict' } }))
app.post('/api/account/delete', (req, res) => {
  const userId = req.session.userId
  if (!userId) return res.status(401).json({ error: 'unauthorized' })
  return res.json({ ok: true })
})
export default app
`;

const CSRF_PROTECT = `import express from 'express'
import session from 'express-session'
import { protect } from './security'
const app = express()
app.use(session({ secret: 's3cret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: true } }))
app.post('/api/account/delete', protect, (req, res) => {
  const userId = req.session.userId
  if (!userId) return res.status(401).json({ error: 'unauthorized' })
  return res.json({ ok: true })
})
export default app
`;

const CSRF_BEARER = `import express from 'express'
const app = express()
app.post('/api/account/delete', (req, res) => {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' })
  return res.json({ ok: true })
})
export default app
`;

describe("Item 2 — CSRF protection", () => {
  it("flags a cookie-session POST route with no CSRF guard and no SameSite flag", () => {
    const out = probeCsrfProtection([f("server/routes/account.ts", CSRF_POSITIVE)]);
    expect(out).toHaveLength(1);
    expect(out[0].probe).toBe(CSRF_PROBE);
    expect(out[0].severity).toBe("high");
    expect(out[0].title).toBe("POST /api/account/delete has no CSRF protection");
    expect(out[0].unverified).toBeUndefined();
    expect(out[0].cwe).toBe("CWE-352");
    expect(out[0].owasp).toEqual(["A01"]);
  });

  it("does NOT flag the same route with a global csurf middleware", () => {
    expect(probeCsrfProtection([f("server/routes/account.ts", CSRF_TOKEN_GLOBAL)])).toHaveLength(0);
  });

  it("does NOT flag the same route with a per-route csrf() middleware", () => {
    expect(probeCsrfProtection([f("server/routes/account.ts", CSRF_TOKEN_ROUTE)])).toHaveLength(0);
  });

  it("does NOT flag the same route where the session cookie sets SameSite: 'strict'", () => {
    expect(probeCsrfProtection([f("server/routes/account.ts", CSRF_SAMESITE)])).toHaveLength(0);
  });

  it("does NOT flag a Bearer-token-only route (CSRF does not apply)", () => {
    expect(probeCsrfProtection([f("server/routes/account.ts", CSRF_BEARER)])).toHaveLength(0);
  });

  it("routes to verification when the guard lives in an imported helper the probe cannot resolve", () => {
    const out = probeCsrfProtection([f("server/routes/account.ts", CSRF_PROTECT)]);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(CSRF_QUESTION);
  });
});

// ---------------------------------------------------------------------------
// Item 3 — Debug mode (JS/TS only)
// ---------------------------------------------------------------------------

const ENV_PROD_DEBUG = `NODE_ENV=production
DEBUG=true
API_URL=https://example.com
`;

const ENV_EXAMPLE_DEBUG = `DEBUG=true
`;

const ENV_NAMESPACE = `DEBUG=app:*
`;

const ENV_PLAIN_DEBUG = `DEBUG=true
`;

const DEBUG_APP_SET = `import express from 'express'
const app = express()
app.set('debug', true)
app.listen(3000)
`;

const DEBUG_DEV_GUARD = `import express from 'express'
const app = express()
if (process.env.NODE_ENV === 'development') {
  app.set('debug', true)
}
app.listen(3000)
`;

const DEBUG_CONFIG_TRUE = `export const config = {
  port: 3000,
  debug: true,
}
`;

describe("Item 3 — Debug mode", () => {
  it("flags DEBUG=true in a .env.production file", () => {
    const out = probeDebugMode([f(".env.production", ENV_PROD_DEBUG)]);
    expect(out).toHaveLength(1);
    expect(out[0].probe).toBe(DEBUG_MODE_PROBE);
    expect(out[0].severity).toBe("high");
    expect(out[0].file).toBe(".env.production");
    expect(out[0].line).toBe(2);
    expect(out[0].unverified).toBeUndefined();
    expect(out[0].cwe).toBe("CWE-489");
    expect(out[0].owasp).toEqual(["A05"]);
  });

  it("flags an unconditional app.set('debug', true) in a server entry", () => {
    const out = probeDebugMode([f("server/index.ts", DEBUG_APP_SET)]);
    expect(out).toHaveLength(1);
    expect(out[0].probe).toBe(DEBUG_MODE_PROBE);
    expect(out[0].line).toBe(3);
    expect(out[0].unverified).toBeUndefined();
  });

  it("flags a debug: true in a server config object", () => {
    const out = probeDebugMode([f("server/config.ts", DEBUG_CONFIG_TRUE)]);
    expect(out).toHaveLength(1);
    expect(out[0].probe).toBe(DEBUG_MODE_PROBE);
    expect(out[0].unverified).toBeUndefined();
  });

  it("does NOT flag DEBUG=true in a .env.example template", () => {
    expect(probeDebugMode([f(".env.example", ENV_EXAMPLE_DEBUG)])).toHaveLength(0);
  });

  it("does NOT flag a debug flag guarded to development only", () => {
    expect(probeDebugMode([f("server/index.ts", DEBUG_DEV_GUARD)])).toHaveLength(0);
  });

  it("does NOT flag a DEBUG log namespace (DEBUG=app:*)", () => {
    expect(probeDebugMode([f(".env.production", ENV_NAMESPACE)])).toHaveLength(0);
  });

  it("routes a plain .env DEBUG=true to verification (production status ambiguous)", () => {
    const out = probeDebugMode([f(".env", ENV_PLAIN_DEBUG)]);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(DEBUG_ENV_QUESTION);
  });
});

// ---------------------------------------------------------------------------
// Item 4 — Logging secrets
// ---------------------------------------------------------------------------

const LOG_PASSWORD = `import express from 'express'
const app = express()
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body
  console.log("login password:", password)
  return res.json({ ok: true })
})
`;

const LOG_TOKEN_OBJ = `import { logger } from './logger'
export function handleLogin(user) {
  logger.info({ token: user.token })
}
`;

const LOG_REQ_BODY = `import express from 'express'
const app = express()
app.post('/api/data', (req, res) => {
  console.log(req.body)
  return res.json({ ok: true })
})
`;

const LOG_LABEL = `export function handleReset(email) {
  console.log("password reset requested")
  return true
}
`;

const LOG_MASKED = `import { mask } from './mask'
export function handleLogin(token) {
  console.log("token:", mask(token))
  return true
}
`;

const LOG_DATA_PARAM = `import { logger } from './logger'
export function handleWebhook(data) {
  logger.info({ data })
}
`;

describe("Item 4 — Logging secrets", () => {
  it("flags console.log('login password:', password) — a secret value, not a label", () => {
    const out = probeSecretLogging([f("server/routes/auth.ts", LOG_PASSWORD)]);
    expect(out).toHaveLength(1);
    expect(out[0].probe).toBe(SECRET_LOGGING_PROBE);
    expect(out[0].severity).toBe("high");
    expect(out[0].unverified).toBeUndefined();
    expect(out[0].cwe).toBe("CWE-532");
    expect(out[0].owasp).toEqual(["A09"]);
  });

  it("flags logger.info({ token: user.token }) — a secret-named key with a non-literal value", () => {
    const out = probeSecretLogging([f("server/handlers.ts", LOG_TOKEN_OBJ)]);
    expect(out).toHaveLength(1);
    expect(out[0].probe).toBe(SECRET_LOGGING_PROBE);
    expect(out[0].unverified).toBeUndefined();
  });

  it("flags console.log(req.body) — the full request body", () => {
    const out = probeSecretLogging([f("server/routes/data.ts", LOG_REQ_BODY)]);
    expect(out).toHaveLength(1);
    expect(out[0].probe).toBe(SECRET_LOGGING_PROBE);
    expect(out[0].unverified).toBeUndefined();
  });

  it("does NOT flag a string-literal label (console.log('password reset requested'))", () => {
    expect(probeSecretLogging([f("server/handlers.ts", LOG_LABEL)])).toHaveLength(0);
  });

  it("does NOT flag a masked value (console.log('token:', mask(token)))", () => {
    expect(probeSecretLogging([f("server/handlers.ts", LOG_MASKED)])).toHaveLength(0);
  });

  it("routes an unresolvable logged value to verification", () => {
    const out = probeSecretLogging([f("server/handlers.ts", LOG_DATA_PARAM)]);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(SECRET_LOGGING_QUESTION);
  });
});

// ---------------------------------------------------------------------------
// Item 5 — File-upload validation
// ---------------------------------------------------------------------------

const UPLOAD_NO_VALIDATION = `import express from 'express'
import multer from 'multer'
const app = express()
const upload = multer({ dest: 'public/uploads/' })
app.post('/upload', upload.single('file'), (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ error: 'no file' })
  return res.json({ ok: true, filename: file.filename })
})
export default app
`;

const UPLOAD_VALIDATED = `import express from 'express'
import multer from 'multer'
const app = express()
const upload = multer({
  dest: 'uploads/',
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)),
  limits: { fileSize: 5 * 1024 * 1024 },
})
app.post('/upload', upload.single('file'), (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ error: 'no file' })
  return res.json({ ok: true, filename: file.filename })
})
export default app
`;

const UPLOAD_UNRESOLVABLE = `import express from 'express'
import multer from 'multer'
import { validateUpload } from './upload-security'
const app = express()
const upload = multer({ dest: 'uploads/' })
app.post('/upload', validateUpload, upload.single('file'), (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ error: 'no file' })
  return res.json({ ok: true, filename: file.filename })
})
export default app
`;

const UPLOAD_WEBROOT_VALIDATED = `import express from 'express'
import multer from 'multer'
const app = express()
const upload = multer({
  dest: 'public/uploads/',
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)),
  limits: { fileSize: 5 * 1024 * 1024 },
})
app.post('/upload', upload.single('file'), (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ error: 'no file' })
  return res.json({ ok: true, filename: file.filename })
})
export default app
`;

describe("Item 5 — File-upload validation", () => {
  it("flags a multer route with no fileFilter, no limits, stored under public/", () => {
    const out = probeFileUploadValidation([f("server/routes/upload.ts", UPLOAD_NO_VALIDATION)]);
    expect(out).toHaveLength(1);
    expect(out[0].probe).toBe(FILE_UPLOAD_PROBE);
    expect(out[0].severity).toBe("high");
    expect(out[0].title).toBe("POST /upload has no file-upload validation");
    expect(out[0].evidence).toMatch(/public\/uploads\//);
    expect(out[0].unverified).toBeUndefined();
    expect(out[0].cwe).toBe("CWE-434");
    expect(out[0].owasp).toEqual(["A08"]);
  });

  it("does NOT flag the same route with a fileFilter, limits, and storage outside the web root", () => {
    expect(
      probeFileUploadValidation([f("server/routes/upload.ts", UPLOAD_VALIDATED)])
    ).toHaveLength(0);
  });

  it("routes to verification when validation lives in an imported helper the probe cannot resolve", () => {
    const out = probeFileUploadValidation([f("server/routes/upload.ts", UPLOAD_UNRESOLVABLE)]);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(FILE_UPLOAD_QUESTION);
  });

  it("routes to verification when validation is present but files are stored under the web root", () => {
    const out = probeFileUploadValidation([
      f("server/routes/upload.ts", UPLOAD_WEBROOT_VALIDATED),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(FILE_UPLOAD_WEBROOT_QUESTION);
  });
});

// ---------------------------------------------------------------------------
// Wiring — the five probes run in a full scan; category caps; verification
// ---------------------------------------------------------------------------

// Reelhouse analyze/image shapes (compacted from the detector-precision
// fixtures): Next.js POST exports with Drizzle mutations and no auth.
const REEL_ANALYZE = `import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chapters } from '@/lib/db/schema'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1)
  if (!chapter) return Response.json({ error: 'Not found' }, { status: 404 })
  await db.update(chapters).set({ status: 'analyzing', updatedAt: sql\`now()\` }).where(eq(chapters.id, id))
  return Response.json({ ok: true })
}
`;

const REEL_IMAGE = `import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chapters, media } from '@/lib/db/schema'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await ctx.params
  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1)
  if (!chapter) return Response.json({ error: 'Not found' }, { status: 404 })
  const [saved] = await db.insert(media).values({ kind: 'clip-image', data: Buffer.from([]) }).returning({ id: media.id })
  await db.update(chapters).set({ updatedAt: sql\`now()\` }).where(eq(chapters.id, id))
  return Response.json({ ok: true, imageMediaId: saved.id })
}
`;

const REEL_PKG = JSON.stringify({
  name: "reelhouse",
  dependencies: { next: "16.0.0", "drizzle-orm": "^0.45.4", pg: "^8.23.1" },
});

function wf(path: string, content: string): WorkspaceFile {
  return { path, content, lineCount: content.split("\n").length } as WorkspaceFile;
}

function emptyPreflight(score = 100): PreFlightReport {
  return {
    engine: "PreFlight",
    probeCount: 113,
    filesScanned: 1,
    filesSkipped: [],
    score,
    counts: {},
    findings: [],
    probeFailures: [],
    failed: null,
  };
}

const AUTH_CODE = `import jwt from 'jsonwebtoken';
export function verifySession(token: string): boolean {
  return Boolean(jwt.verify(token, process.env.AUTH_SECRET || 'dev-secret'));
}
`;

// One verified high finding per probe (constructed, not scanned — the
// cap behaviour is what is under test here).
const FIVE_VERIFIED: PreFlightFinding[] = [
  {
    severity: "high",
    probe: "Rate Limit",
    title: "POST /api/auth/login has no rate-limit guard",
    file: "server/routes/auth.ts",
    line: 1,
    evidence: "POST /api/auth/login — no rate-limit guard found in the scanned files.",
    remediation: "Add a rate limiter to this route.",
    owasp: ["A07"],
    cwe: "CWE-307",
  },
  {
    severity: "high",
    probe: "CSRF Protection",
    title: "POST /api/account/delete has no CSRF protection",
    file: "server/routes/account.ts",
    line: 1,
    evidence: "POST /api/account/delete — cookie session in use; no CSRF guard found.",
    remediation: "Add CSRF protection to this route.",
    owasp: ["A01"],
    cwe: "CWE-352",
  },
  {
    severity: "high",
    probe: "Debug Mode",
    title: "Debug mode enabled in .env.production",
    file: ".env.production",
    line: 1,
    evidence: ".env.production:1 — DEBUG=true",
    remediation: "Remove the debug flag from this production env file.",
    owasp: ["A05"],
    cwe: "CWE-489",
  },
  {
    severity: "high",
    probe: "Secret Logging",
    title: "Log call writes a secret (the password value)",
    file: "server/routes/auth.ts",
    line: 1,
    evidence: "server/routes/auth.ts:1 — console.log logs the password value",
    remediation: "Remove the secret from this log call.",
    owasp: ["A09"],
    cwe: "CWE-532",
  },
  {
    severity: "high",
    probe: "File Upload Validation",
    title: "POST /upload has no file-upload validation",
    file: "server/routes/upload.ts",
    line: 1,
    evidence: "POST /upload — no file-type, size, or content validation found.",
    remediation: "Validate uploads before storing them.",
    owasp: ["A08"],
    cwe: "CWE-434",
  },
];

const FIVE_UNVERIFIED: PreFlightFinding[] = FIVE_VERIFIED.map((x, i) => ({
  ...x,
  unverified: true,
  remediation: [
    RATE_LIMIT_QUESTION,
    CSRF_QUESTION,
    DEBUG_ENV_QUESTION,
    SECRET_LOGGING_QUESTION,
    FILE_UPLOAD_QUESTION,
  ][i],
}));

function baseReportInput(overrides: Record<string, unknown> = {}) {
  return {
    projectTitle: "Test App",
    completenessScore: 72,
    categoryScores: {
      authentication: { score: 8, reason: "Login and sessions implemented." },
      security: { score: 5, reason: "Some gaps remain." },
    },
    findings: [],
    missingFeatures: [],
    scanGaps: { failed: null, probeFailures: [], filesSkipped: [], filesScanned: 40 },
    ...overrides,
  } as any;
}

describe("Wiring — the five probes run in a full scan", () => {
  it("a full scan carries Rate Limit findings for the Reelhouse analyze/image routes", () => {
    const files = [
      f("app/api/chapters/[id]/analyze/route.ts", REEL_ANALYZE),
      f("app/api/chapters/[id]/clips/[index]/image/route.ts", REEL_IMAGE),
      f("package.json", REEL_PKG),
    ];
    const r = runPreFlightScan(files, scan);
    const rl = byProbe(r.findings, RATE_LIMIT_PROBE);
    expect(rl.map((x) => x.file).sort()).toEqual([
      "app/api/chapters/[id]/analyze/route.ts",
      "app/api/chapters/[id]/clips/[index]/image/route.ts",
    ]);
    for (const x of rl) {
      expect(x.severity).toBe("high");
      expect(x.unverified).toBeUndefined();
    }
    // The probe count grows by the five new probes.
    expect(r.probeCount).toBeGreaterThanOrEqual(118);
  });

  it("a full scan does NOT carry a CSRF finding for the Reelhouse routes (they do not rely on cookie auth — the no-auth finding already covers them)", () => {
    const files = [
      f("app/api/chapters/[id]/analyze/route.ts", REEL_ANALYZE),
      f("app/api/chapters/[id]/clips/[index]/image/route.ts", REEL_IMAGE),
      f("package.json", REEL_PKG),
    ];
    const r = runPreFlightScan(files, scan);
    expect(byProbe(r.findings, CSRF_PROBE)).toHaveLength(0);
    // The missing auth is still flagged by the destructive-handler finding.
    expect(hasTitle(r, "POST handler performs database mutation")).toBe(true);
  });

  it("a full scan carries each probe's findings with the right probe names and severities", () => {
    const files = [
      f("server/routes/auth.ts", LOGIN_NO_GUARD),
      f("server/routes/account.ts", CSRF_POSITIVE),
      f(".env.production", ENV_PROD_DEBUG),
      f("server/handlers.ts", LOG_PASSWORD),
      f("server/routes/upload.ts", UPLOAD_NO_VALIDATION),
      f("package.json", JSON.stringify({ name: "demo", dependencies: { express: "^4.0.0" } })),
    ];
    const r = runPreFlightScan(files, scan);
    for (const probe of [RATE_LIMIT_PROBE, CSRF_PROBE, DEBUG_MODE_PROBE, SECRET_LOGGING_PROBE, FILE_UPLOAD_PROBE]) {
      const found = byProbe(r.findings, probe);
      expect(found.length, probe).toBeGreaterThanOrEqual(1);
      for (const x of found) expect(x.severity).toBe("high");
    }
  });

  it("an unverified finding from each probe never caps a score", () => {
    const files = [wf("server/auth.ts", AUTH_CODE)];
    const baseline = computeDeterministicAssessment(files, emptyPreflight());
    const withUnverified = computeDeterministicAssessment(files, {
      ...emptyPreflight(),
      findings: FIVE_UNVERIFIED,
    });
    for (const key of Object.keys(baseline.categories) as (keyof typeof baseline.categories)[]) {
      expect(withUnverified.categories[key].score).toBe(baseline.categories[key].score);
    }
    expect(withUnverified.capsApplied.join(" ")).not.toMatch(/reconciliation/i);
  });

  it("a verified high finding from each probe caps the right categories at 6", () => {
    const files = [wf("server/auth.ts", AUTH_CODE)];
    const baseline = computeDeterministicAssessment(files, emptyPreflight());
    const withVerified = computeDeterministicAssessment(files, {
      ...emptyPreflight(),
      findings: FIVE_VERIFIED,
    });
    expect(withVerified.capsApplied.join(" ")).toMatch(/reconciliation/i);
    // Authentication and Security were above 6 in the baseline, so the
    // Rate Limit / CSRF findings cap them at 6.
    expect(baseline.categories.authentication.score).toBeGreaterThan(6);
    expect(withVerified.categories.authentication.score).toBe(6);
    expect(baseline.categories.security.score).toBeGreaterThan(6);
    expect(withVerified.categories.security.score).toBe(6);
  });

  it("each unverified finding renders in needsVerification with its specific question", () => {
    const r = buildFinalReadReport(baseReportInput({ findings: FIVE_UNVERIFIED }));
    expect(r.liabilities).toHaveLength(0);
    expect(r.needsVerification).toHaveLength(5);
    const byTitle = new Map(r.needsVerification.map((i) => [i.title, i]));
    expect(
      byTitle.get("POST /api/auth/login has no rate-limit guard")?.verification?.howToCheck
    ).toBe(RATE_LIMIT_QUESTION);
    expect(
      byTitle.get("POST /api/account/delete has no CSRF protection")?.verification?.howToCheck
    ).toBe(CSRF_QUESTION);
    expect(
      byTitle.get("Debug mode enabled in .env.production")?.verification?.howToCheck
    ).toBe(DEBUG_ENV_QUESTION);
    expect(
      byTitle.get("Log call writes a secret (the password value)")?.verification?.howToCheck
    ).toBe(SECRET_LOGGING_QUESTION);
    expect(
      byTitle.get("POST /upload has no file-upload validation")?.verification?.howToCheck
    ).toBe(FILE_UPLOAD_QUESTION);
    for (const item of r.needsVerification) {
      expect(item.verification?.whatEachAnswerMeans).toMatch(/becomes a liability/);
    }
  });
});

describe("Category map — the five probe names map to their categories", () => {
  it("PROBE_CATEGORY_MAP has an entry for each new probe", () => {
    expect(PROBE_CATEGORY_MAP["Rate Limit"]).toEqual(["authentication", "security"]);
    expect(PROBE_CATEGORY_MAP["CSRF Protection"]).toEqual(["authentication", "security"]);
    expect(PROBE_CATEGORY_MAP["Debug Mode"]).toEqual(["security"]);
    expect(PROBE_CATEGORY_MAP["Secret Logging"]).toEqual(["security"]);
    expect(PROBE_CATEGORY_MAP["File Upload Validation"]).toEqual(["security"]);
  });
});
