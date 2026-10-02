// Deterministic scoring tests. Core property: the same workspace always
// yields the same scores and missing-feature list (no randomness, no clock).
// Report structure is unchanged: 10 categories, integer 0-10 scores, total
// exactly the sum, missing features as {feature, category} facts.
import { describe, it, expect } from "vitest";
import {
  computeDeterministicAssessment,
  formatAssessmentForPrompt,
  CATEGORY_KEYS,
} from "../server/deterministic-score";
import type { PreFlightReport } from "../shared/preflight-types";
import type { WorkspaceFile } from "../server/workspace";

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
import crypto from 'crypto';

// Session management for the application.
// Creates signed tokens, verifies them, and tracks expiry.

interface SessionPayload {
  userId: string;
  email: string;
  issuedAt: number;
}

const SECRET = process.env.AUTH_SECRET || 'dev-secret';

export function createSession(userId: string, email: string): string {
  try {
    const payload: SessionPayload = { userId, email, issuedAt: Date.now() };
    return jwt.sign(payload, SECRET, { expiresIn: '30d' });
  } catch (err) {
    throw new Error('session creation failed');
  }
}

export function verifySession(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, SECRET) as SessionPayload;
  } catch (err) {
    return null;
  }
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function sessionCookie(token: string): string {
  // HttpOnly cookie, 30 day expiry, Lax for OAuth-style flows.
  return \`session=\${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000\`;
}
`;

const DB_CODE = `import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Database layer: users table plus the sessions table.
// Schema is versioned; migrations live in ./migrations.

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

const sqlite = new Database('app.db');
export const db = drizzle(sqlite);

export function getUserByEmail(email: string) {
  try {
    return db.select().from(users).where(eq(users.email, email)).get();
  } catch (err) {
    throw new Error('db lookup failed');
  }
}

function eq(a: any, b: any) { return { a, b }; }
`;

const LOGIN_CODE = `import React from 'react';

// Login form component.
// Collects credentials and posts them to the auth endpoint.

interface LoginProps {
  onSuccess: (token: string) => void;
}

export function Login({ onSuccess }: LoginProps) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error('login failed');
      const data = await res.json();
      onSuccess(data.token);
    } catch (err) {
      setError('Could not sign in. Check your credentials.');
    }
  }

  return (
    <form onSubmit={submit}>
      <h1>Sign in</h1>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" />
      {error && <p>{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  );
}
`;

const HEALTHY_NEXT: WorkspaceFile[] = [
  wf("package.json", JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0", drizzle: "1.0.0" }, scripts: { build: "next build" } })),
  wf("app/layout.tsx", `export default function RootLayout({children}: {children: React.ReactNode}) {\n  return <html><body>{children}</body></html>;\n}`),
  wf("app/page.tsx", `export default function Home() {\n  try {\n    return <div><h1>Hello</h1><p>Welcome to the app.</p></div>;\n  } catch (e) {\n    return <div>Something went wrong.</div>;\n  }\n}`),
  wf("server/auth.ts", AUTH_CODE),
  wf("components/login.tsx", LOGIN_CODE),
  wf("lib/db.ts", DB_CODE),
  wf("app/api/health/route.ts", `export async function GET() {\n  return Response.json({ ok: true });\n}`),
  wf("app/api/users/route.ts", `import { db, users } from '@/lib/db';\n\nexport async function GET() {\n  try {\n    const rows = db.select().from(users).all();\n    return Response.json({ users: rows });\n  } catch (err) {\n    return Response.json({ error: 'failed' }, { status: 500 });\n  }\n}`),
  wf("README.md", "# App\n\nA complete application with auth, database, and API routes.\n\n## Usage\n\nInstall dependencies and run the dev server.\n\n## API\n\n- GET /api/health — liveness probe\n- GET /api/users — list users\n\n## Auth\n\nJWT sessions via HttpOnly cookies.\n\n## Database\n\nSQLite via Drizzle ORM.\n"),
];

describe("deterministic scoring", () => {
  it("is fully deterministic across runs", () => {
    const a = computeDeterministicAssessment(HEALTHY_NEXT, emptyPreflight());
    const b = computeDeterministicAssessment(HEALTHY_NEXT, emptyPreflight());
    expect(a).toEqual(b);
  });

  it("scores are integers 0-10 and total is the exact sum", () => {
    const a = computeDeterministicAssessment(HEALTHY_NEXT, emptyPreflight());
    expect(Object.keys(a.categories).sort()).toEqual([...CATEGORY_KEYS].sort());
    let sum = 0;
    for (const k of CATEGORY_KEYS) {
      const c = a.categories[k];
      expect(Number.isInteger(c.score)).toBe(true);
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(10);
      expect(c.max).toBe(10);
      expect(c.evidence.length).toBeGreaterThan(0);
      sum += c.score;
    }
    expect(a.completenessScore).toBe(sum);
  });

  it("rewards a complete Next.js app", () => {
    const a = computeDeterministicAssessment(HEALTHY_NEXT, emptyPreflight());
    expect(a.categories.serverStarts.score).toBe(10);
    expect(a.categories.authentication.score).toBe(10);
    expect(a.categories.databaseLayer.score).toBeGreaterThanOrEqual(8);
    expect(a.completenessScore).toBeGreaterThan(80);
  });

  it("detects dangling auth and lists it as a missing feature", () => {
    const files = [
      wf("package.json", JSON.stringify({ dependencies: { react: "18" } })),
      wf("index.html", "<div id=root></div>"),
      wf("src/App.tsx", `export function App() { return <button>Sign in</button>; }`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.score).toBeLessThanOrEqual(3);
    expect(a.missingFeatures.some((m) => /authentication/i.test(m.feature))).toBe(true);
  });

  it("derives security from the PreFlight score", () => {
    const clean = computeDeterministicAssessment(HEALTHY_NEXT, emptyPreflight(100));
    const bad = computeDeterministicAssessment(HEALTHY_NEXT, emptyPreflight(40));
    expect(clean.categories.security.score).toBe(10);
    expect(bad.categories.security.score).toBe(4);
  });

  it("withholds security judgment when the scan is incomplete", () => {
    const failed = { ...emptyPreflight(), failed: "boom", probeFailures: [{ probe: "x", error: "y" }] };
    const a = computeDeterministicAssessment(HEALTHY_NEXT, failed);
    expect(a.categories.security.score).toBe(5);
    expect(a.categories.security.note).toBe("scan-incomplete");
  });

  it("applies CAP A for a missing front door and sums to exactly 30", () => {
    const files = [
      wf("package.json", JSON.stringify({ dependencies: { next: "14.0.0" } })),
      wf("components/widget.tsx", `export function Widget() { return <div/>; }`),
      wf("components/other.tsx", `export function Other() { return <div/>; }`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.capsApplied.some((c) => c.startsWith("CAP A"))).toBe(true);
    expect(a.completenessScore).toBe(30);
  });

  it("applies CAP C for Stripe without a webhook", () => {
    const files = [
      wf("package.json", JSON.stringify({ dependencies: { next: "14.0.0", stripe: "1.0.0" } })),
      wf("app/layout.tsx", "export default function L({c}) { return c; }"),
      wf("app/page.tsx", "export default function P() { return <div/>; }"),
      wf("lib/stripe.ts", `import Stripe from 'stripe';\nexport const stripe = new Stripe('sk_test');`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.capsApplied.some((c) => c.startsWith("CAP C"))).toBe(true);
    expect(a.missingFeatures.some((m) => /webhook/i.test(m.feature))).toBe(true);
  });

  it("turns stubs and TODOs into missing features with anchors", () => {
    const files = [
      wf("package.json", JSON.stringify({ dependencies: { next: "14.0.0" } })),
      wf("app/layout.tsx", "export default function L({c}) { return c; }"),
      wf("app/page.tsx", "export default function P() { return <div/>; }"),
      wf("lib/worker.ts", `// TODO: implement retry logic\nexport function stub() { /* stub */ }`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    const feats = a.missingFeatures.map((m) => m.feature);
    expect(feats.some((f) => /TODO.*lib\/worker\.ts/i.test(f))).toBe(true);
    const anchored = a.missingFeatures.find((m) => /worker\.ts/.test(m.feature));
    expect(anchored?.evidence.some((e) => e.includes("lib/worker.ts:"))).toBe(true);
  });

  it("formats a ground-truth prompt block", () => {
    const a = computeDeterministicAssessment(HEALTHY_NEXT, emptyPreflight());
    const text = formatAssessmentForPrompt(a);
    expect(text).toContain(`Total completeness score: ${a.completenessScore}/100`);
    for (const k of CATEGORY_KEYS) {
      expect(text).toContain(`${k}: ${a.categories[k].score}/10`);
    }
  });

  it("does not penalize a stateless tool for missing auth/db", () => {
    const files = [
      wf("package.json", JSON.stringify({ dependencies: { react: "18" } })),
      wf("index.html", "<div id=root></div>"),
      wf("src/App.tsx", `export function App() { const [t, setT] = React.useState(''); return <textarea value={t}/>; }`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.note).toBe("not-in-scope");
    expect(a.categories.databaseLayer.note).toBe("not-in-scope");
    expect(a.categories.authentication.score).toBe(10);
    expect(a.categories.databaseLayer.score).toBe(10);
  });
});
