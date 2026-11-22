// Detector precision — method labels, RLS scoping, taint provenance
// (finalread-detector-precision-fix-spec.md, APPROVED).
//
// The Reelhouse 74/100 scan (2026-11-19) is the motivating case: 9 of
// its 10 liabilities do not hold up against the code. These tests drive
// the vendored probes directly, then the first-party post-filters, and
// assert the filters correct the output without weakening detection:
//   Item 1 — a POST/GET-only route is re-titled (not dropped), a real
//     DELETE export is kept, a Bearer + timingSafeEqual gate is
//     recognised and the finding dropped.
//   Item 2 — an RLS critical is kept for a Supabase app, dropped for a
//     server-side-only (Neon/Drizzle) app, and routed to verification
//     when the access model cannot be determined.
//   Item 3 — a database-stored or validated URL is not flagged as SSRF;
//     a request-derived URL without validation still is.
//   Item 4 — an unverified finding of each of the three kinds never
//     caps a score and renders in the verification bucket with its
//     specific question.
//
// Fixtures mirror the Reelhouse Nov 12 zip routes (the audio route is
// verbatim; ingest/analyze/image are compacted to the shapes the
// filters depend on). No code is built, committed, or pushed here.
import { describe, it, expect } from "vitest";
import { probeAPIRouteAuth } from "../server/preflight/vendor/lib/probes/auth.js";
import { probeSupabaseRLS } from "../server/preflight/vendor/lib/probes/database.js";
import { probeTaintFlow } from "../server/preflight/vendor/lib/probes/taint-engine.js";
import { probeSSRFOpenRedirect } from "../server/preflight/vendor/lib/probes/transport.js";
import {
  calibrateDestructiveHandlerFindings,
  DESTRUCTIVE_METHOD_QUESTION,
} from "../server/preflight/destructive-handler-filter";
import {
  calibrateRlsFindings,
  RLS_ACCESS_MODEL_QUESTION,
} from "../server/preflight/rls-scope-filter";
import {
  calibrateSsrfTaintFindings,
  SSRF_PROVENANCE_QUESTION,
  SSRF_CALLEE_QUESTION,
} from "../server/preflight/ssrf-taint-filter";
import { runPreFlightScan } from "../server/preflight-scan";
import { scan } from "../server/preflight/vendor/lib/cockpit-scan.js";
import { computeDeterministicAssessment } from "../server/deterministic-score";
import { buildFinalReadReport } from "../shared/finalread-report";
import type { PreFlightReport } from "../shared/preflight-types";
import type { WorkspaceFile } from "../server/workspace";

const f = (path: string, content: string) => ({ path, content });
const contentsOf = (files: { path: string; content: string }[]) =>
  new Map(files.map((x) => [x.path, x.content]));
const titles = (r: { findings: { title: string }[] }) => r.findings.map((x) => x.title);
const hasTitle = (r: { findings: { title: string }[] }, needle: string) =>
  titles(r).some((t) => t.includes(needle));

// ---------------------------------------------------------------------------
// Item 1 fixtures — Reelhouse route shapes
// ---------------------------------------------------------------------------

// Ingest, verbatim authorized() helper + compact POST. Bearer +
// timingSafeEqual, called first in POST; Drizzle writes below.
const REEL_INGEST = `import { timingSafeEqual } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chapters, segments } from '@/lib/db/schema'

function authorized(req: Request) {
  const expected = process.env.INGEST_API_KEY
  if (!expected) return 'unconfigured' as const
  const header = req.headers.get('authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b) ? ('ok' as const) : ('denied' as const)
}

export async function POST(req: Request) {
  const auth = authorized(req)
  if (auth === 'unconfigured')
    return Response.json({ error: 'INGEST_API_KEY is not configured on this app' }, { status: 503 })
  if (auth === 'denied') return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.insert(chapters).values({ externalId: 'x', status: 'receiving' }).returning({ id: chapters.id })
    await tx.delete(segments).where(eq(segments.chapterId, row.id))
    await tx.update(chapters).set({ status: 'received' }).where(eq(chapters.id, row.id))
    return { chapterId: row.id }
  })
  return Response.json({ ok: true, ...result })
}
`;

// Analyze: POST only, Drizzle update, no auth.
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

// Image: POST only, Drizzle insert/update, no auth.
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

// Audio route, verbatim from the Reelhouse Nov 12 zip. GET only; the URL
// is a stored field (seg.audioUrl, read by a request-derived lookup key)
// and is validated by isSafeRemoteUrl before the fetch; Drizzle writes
// below the fetch.
const REEL_AUDIO = `import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { media, segments } from '@/lib/db/schema'
import { isSafeRemoteUrl } from '@/lib/safe-url'

export const maxDuration = 60

const UUID = /^[0-9a-f-]{36}$/i
const MAX_BYTES = 20 * 1024 * 1024

function respond(data: Buffer | Uint8Array, contentType: string) {
  return new Response(new Uint8Array(data), {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=31536000, immutable' },
  })
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!UUID.test(id)) return new Response('Not found', { status: 404 })
  const [seg] = await db.select().from(segments).where(eq(segments.id, id)).limit(1)
  if (!seg) return new Response('Not found', { status: 404 })

  if (seg.audioMediaId) {
    const [m] = await db.select().from(media).where(eq(media.id, seg.audioMediaId)).limit(1)
    if (m) return respond(m.data, m.contentType)
  }
  if (!seg.audioUrl || !isSafeRemoteUrl(seg.audioUrl)) return new Response('No audio', { status: 404 })

  const upstream = await fetch(seg.audioUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!upstream.ok) return new Response('Upstream audio unavailable', { status: 502 })
  const buf = Buffer.from(await upstream.arrayBuffer())
  if (buf.length > MAX_BYTES) return new Response('Audio too large', { status: 413 })
  const contentType = upstream.headers.get('content-type')?.split(';')[0] || 'audio/mpeg'

  const [saved] = await db.insert(media).values({ kind: 'segment-audio', contentType, data: buf }).returning({ id: media.id })
  await db.update(segments).set({ audioMediaId: saved.id }).where(eq(segments.id, id))
  return respond(buf, contentType)
}
`;

// Genuine DELETE export without auth — the positive control.
const REAL_DELETE = `import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chapters } from '@/lib/db/schema'

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  await db.delete(chapters).where(eq(chapters.id, id))
  return Response.json({ ok: true })
}
`;

// An auth helper that is defined but never called — dead code, not a
// gate. The finding must NOT be dropped on its account.
const DEAD_AUTH_HELPER = `import { timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chapters } from '@/lib/db/schema'

function authorized(req: Request) {
  const expected = process.env.INGEST_API_KEY
  if (!expected) return false
  const header = req.headers.get('authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : ''
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  await db.update(chapters).set({ status: 'x' }).where(eq(chapters.id, id))
  return Response.json({ ok: true })
}
`;

// A destructive method exported only under an alias — the filter cannot
// resolve it, so it routes to verification instead of re-titling.
const ALIASED_DELETE = `import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chapters } from '@/lib/db/schema'

const handler = async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  await db.delete(chapters).where(eq(chapters.id, id))
  return Response.json({ ok: true })
}

export { handler as DELETE }
`;

function destructiveFindings(files: { path: string; content: string }[]) {
  return (probeAPIRouteAuth(files) as any[]).filter((x) =>
    String(x.id || "").startsWith("api-destructive-")
  );
}

function calibratedDestructive(files: { path: string; content: string }[]) {
  return calibrateDestructiveHandlerFindings(destructiveFindings(files), contentsOf(files));
}

describe("Item 1 — destructive-handler method labels", () => {
  it("the probe still fires the (DELETE/PUT/PATCH) title on the four Reelhouse routes", () => {
    const files = [
      f("app/api/ingest/route.ts", REEL_INGEST),
      f("app/api/chapters/[id]/analyze/route.ts", REEL_ANALYZE),
      f("app/api/chapters/[id]/clips/[index]/image/route.ts", REEL_IMAGE),
      f("app/api/segments/[id]/audio/route.ts", REEL_AUDIO),
    ];
    expect(destructiveFindings(files).map((x) => x.file).sort()).toEqual([
      "app/api/chapters/[id]/analyze/route.ts",
      "app/api/chapters/[id]/clips/[index]/image/route.ts",
      "app/api/ingest/route.ts",
      "app/api/segments/[id]/audio/route.ts",
    ]);
    for (const x of destructiveFindings(files)) {
      expect(x.title).toContain("Destructive HTTP handler (DELETE/PUT/PATCH)");
    }
  });

  it("drops the ingest finding: its Bearer + timingSafeEqual gate is recognised", () => {
    const files = [f("app/api/ingest/route.ts", REEL_INGEST)];
    expect(destructiveFindings(files)).toHaveLength(1);
    expect(calibratedDestructive(files)).toHaveLength(0);
  });

  it("re-titles analyze and image to POST, audio to GET — mutation kept, label fixed", () => {
    const files = [
      f("app/api/chapters/[id]/analyze/route.ts", REEL_ANALYZE),
      f("app/api/chapters/[id]/clips/[index]/image/route.ts", REEL_IMAGE),
      f("app/api/segments/[id]/audio/route.ts", REEL_AUDIO),
    ];
    const out = calibratedDestructive(files);
    expect(out).toHaveLength(3);
    const byFile = new Map(out.map((x: any) => [x.file, x]));
    expect(byFile.get("app/api/chapters/[id]/analyze/route.ts").title).toBe(
      "POST handler performs database mutation without auth check"
    );
    expect(byFile.get("app/api/chapters/[id]/clips/[index]/image/route.ts").title).toBe(
      "POST handler performs database mutation without auth check"
    );
    expect(byFile.get("app/api/segments/[id]/audio/route.ts").title).toBe(
      "GET handler performs database mutation without auth check"
    );
    // Severity and evidence are kept; the remediation names the real method.
    for (const x of out) {
      expect(x.severity).toBe("high");
      expect(x.remediation).toMatch(/POST handler|GET handler/);
    }
  });

  it("keeps a genuine DELETE export as a (DELETE/PUT/PATCH) liability", () => {
    const files = [f("app/api/chapters/[id]/route.ts", REAL_DELETE)];
    expect(destructiveFindings(files)).toHaveLength(1);
    const out = calibratedDestructive(files);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain("Destructive HTTP handler (DELETE/PUT/PATCH)");
    expect(out[0].unverified).toBeUndefined();
  });

  it("does NOT drop on a defined-but-never-called auth helper", () => {
    const files = [f("app/api/ingest/route.ts", DEAD_AUTH_HELPER)];
    expect(destructiveFindings(files)).toHaveLength(1);
    const out = calibratedDestructive(files);
    expect(out).toHaveLength(1);
    // The helper is dead code, so the finding is re-titled (POST), not dropped.
    expect(out[0].title).toBe("POST handler performs database mutation without auth check");
  });

  it("routes an aliased DELETE export to verification with the method question", () => {
    const files = [f("app/api/chapters/[id]/route.ts", ALIASED_DELETE)];
    expect(destructiveFindings(files)).toHaveLength(1);
    const out = calibratedDestructive(files);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(DESTRUCTIVE_METHOD_QUESTION);
  });

  it("wiring: a full scan no longer carries the (DELETE/PUT/PATCH) title for the Reelhouse routes", () => {
    const files = [
      f("app/api/ingest/route.ts", REEL_INGEST),
      f("app/api/chapters/[id]/analyze/route.ts", REEL_ANALYZE),
      f("app/api/chapters/[id]/clips/[index]/image/route.ts", REEL_IMAGE),
      f("app/api/segments/[id]/audio/route.ts", REEL_AUDIO),
      f("package.json", JSON.stringify({ name: "reelhouse", dependencies: { next: "16.0.0" } })),
    ];
    const r = runPreFlightScan(files, scan);
    expect(hasTitle(r, "Destructive HTTP handler (DELETE/PUT/PATCH)")).toBe(false);
    expect(hasTitle(r, "POST handler performs database mutation")).toBe(true);
    expect(hasTitle(r, "GET handler performs database mutation")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 2 fixtures — database access models
// ---------------------------------------------------------------------------

const MIGRATION = `CREATE TABLE IF NOT EXISTS books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL
);
`;

const SUPABASE_PKG = JSON.stringify({
  name: "demo",
  dependencies: { "@supabase/supabase-js": "^2.0.0", next: "16.0.0" },
});
const SUPABASE_CLIENT = `import { createClient } from '@supabase/supabase-js'
export const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
`;

const DRIZZLE_PKG = JSON.stringify({
  name: "reelhouse",
  dependencies: { "drizzle-orm": "^0.45.4", pg: "^8.23.1", next: "16.4.3" },
});
const DRIZZLE_DB = `import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
export const db = drizzle(pool, { schema })
`;

function rlsFindings(files: { path: string; content: string }[]) {
  return (probeSupabaseRLS(files) as any[]).filter((x) =>
    String(x.id || "").startsWith("rls-")
  );
}

function calibratedRls(files: { path: string; content: string }[]) {
  return calibrateRlsFindings(rlsFindings(files), contentsOf(files));
}

describe("Item 2 — RLS scoping", () => {
  it("the probe still fires the per-table RLS criticals on a migration without RLS", () => {
    const files = [f("migrations/0001_books.sql", MIGRATION)];
    const raw = rlsFindings(files);
    expect(raw.map((x) => x.title).sort()).toEqual([
      'Table "books" missing ENABLE ROW LEVEL SECURITY',
      'Table "sessions" missing ENABLE ROW LEVEL SECURITY',
    ]);
    for (const x of raw) expect(x.severity).toBe("critical");
  });

  it("keeps the RLS criticals for a Supabase app", () => {
    const files = [
      f("package.json", SUPABASE_PKG),
      f("lib/supabase.ts", SUPABASE_CLIENT),
      f("migrations/0001_books.sql", MIGRATION),
    ];
    expect(rlsFindings(files)).toHaveLength(2);
    const out = calibratedRls(files);
    expect(out).toHaveLength(2);
    for (const x of out) {
      expect(x.unverified).toBeUndefined();
      expect(x.severity).toBe("critical");
    }
  });

  it("drops the RLS criticals for a server-side-only Neon/Drizzle app", () => {
    const files = [
      f("package.json", DRIZZLE_PKG),
      f("lib/db/index.ts", DRIZZLE_DB),
      f("migrations/0001_books.sql", MIGRATION),
    ];
    expect(rlsFindings(files)).toHaveLength(2);
    expect(calibratedRls(files)).toHaveLength(0);
  });

  it("routes to verification when no database client is identifiable", () => {
    const files = [f("migrations/0001_books.sql", MIGRATION)];
    expect(rlsFindings(files)).toHaveLength(2);
    const out = calibratedRls(files);
    expect(out).toHaveLength(2);
    for (const x of out) {
      expect(x.unverified).toBe(true);
      expect(x.remediation).toBe(RLS_ACCESS_MODEL_QUESTION);
    }
  });

  it("leaves the already-gated RLS findings alone (permissive / disabled / client-unprotected)", () => {
    const permissive = `CREATE TABLE IF NOT EXISTS books (id uuid PRIMARY KEY);
CREATE POLICY "open" ON books FOR SELECT USING (true);
`;
    const files = [
      f("package.json", DRIZZLE_PKG),
      f("lib/db/index.ts", DRIZZLE_DB),
      f("migrations/0001_books.sql", permissive),
    ];
    const raw = rlsFindings(files);
    // The per-table critical is dropped; the permissive-policy finding passes through.
    const out = calibratedRls(files);
    expect(out.some((x: any) => String(x.id).startsWith("rls-permissive-"))).toBe(true);
    expect(out.some((x: any) => x.title.includes("missing ENABLE ROW LEVEL SECURITY"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item 3 fixtures — SSRF provenance
// ---------------------------------------------------------------------------

// A database-stored URL with NO validation guard: step 1 alone drops it.
const DB_STORED_NO_GUARD = `import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { segments } from '@/lib/db/schema'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const [seg] = await db.select().from(segments).where(eq(segments.id, id)).limit(1)
  if (!seg) return new Response('Not found', { status: 404 })
  const upstream = await fetch(seg.audioUrl)
  return new Response(upstream.body)
}
`;

// The real SSRF shape: a request-derived URL, no validation.
const REQ_URL_DIRECT = `export async function GET(req: Request) {
  const u = req.query.url
  const res = await fetch(u)
  return Response.json({ ok: true })
}
`;

// The same shape with the URL passed through a variable first.
const REQ_URL_VARIABLE = `export async function GET(req: Request) {
  const u = req.query.url
  const target = u
  const res = await fetch(target)
  return Response.json({ ok: true })
}
`;

// A request-derived URL that passes a safe-URL guard first.
const VALIDATED_URL_GUARD = `function isSafeRemoteUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

export async function GET(req: Request) {
  const u = req.query.url
  if (!isSafeRemoteUrl(u)) return Response.json({ error: 'bad url' }, { status: 400 })
  const res = await fetch(u)
  return Response.json({ ok: true })
}
`;

// The same guard, with the validator result held in a flag first.
const VALIDATED_URL_FLAG = `function isSafeUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export async function GET(req: Request) {
  const u = req.query.url
  const ok = isSafeUrl(u)
  if (!ok) return Response.json({ error: 'bad url' }, { status: 400 })
  const res = await fetch(u)
  return Response.json({ ok: true })
}
`;

function ssrfFindings(files: { path: string; content: string }[]) {
  return (probeTaintFlow(files) as any[]).filter((x) =>
    String(x.id || "").startsWith("taint-ssrf-outbound-")
  );
}

function calibratedSsrf(files: { path: string; content: string }[]) {
  return calibrateSsrfTaintFindings(ssrfFindings(files), contentsOf(files));
}

// Transport-probe SSRF (finalread-self-scan-fixes-spec.md A2): the vendored
// line regex matches ANY identifier containing "request", so a database
// rebind call reads as a fetch. The calibration must resolve the callee.
function transportSsrfFindings(files: { path: string; content: string }[]) {
  return (probeSSRFOpenRedirect(files) as any[]).filter((x) => x.probe === "SSRF");
}

function calibratedTransportSsrf(files: { path: string; content: string }[]) {
  return calibrateSsrfTaintFindings(transportSsrfFindings(files), contentsOf(files));
}

// The self-scan shape: a route calls a DB-only helper whose name contains
// "request", with request-derived arguments.
const REBIND_ROUTE = `import { rebindProjectRequest } from '../finalread-projects'

export async function POST(req: Request) {
  const requestCode = 'abc'
  const result = await rebindProjectRequest(req.params.id, req.user.id, requestCode)
  return Response.json({ ok: result === 'ok' })
}
`;

const REBIND_IMPL = `import { getDb } from '../db'

export async function rebindProjectRequest(projectId: string, sellerUserId: string, requestCode: string) {
  const db = getDb()
  const project = await db.get('SELECT * FROM finalread_projects WHERE id = $1', [projectId])
  if (!project) return 'not-found'
  await db.run('UPDATE finalread_projects SET request_id = $1 WHERE id = $2', [requestCode, projectId])
  return 'ok'
}
`;

// A real outbound fetch with a request-derived URL (positive control).
const FETCH_REQ_URL = `export async function GET(req: Request) {
  const res = await fetch(req.query.url)
  return Response.json({ ok: true })
}
`;

// A *Request helper the scanner cannot resolve anywhere: verification,
// never a hard high.
const UNRESOLVABLE_REQUEST_HELPER = `export async function POST(req: Request) {
  const result = await lookupProjectRequest(req.params.id, req.user.id)
  return Response.json({ ok: result === 'ok' })
}
`;

describe("Item 3 — SSRF/taint provenance", () => {
  it("drops the Reelhouse audio-route SSRF: stored URL, validated by isSafeRemoteUrl", () => {
    const files = [f("app/api/segments/[id]/audio/route.ts", REEL_AUDIO)];
    const raw = ssrfFindings(files);
    expect(raw).toHaveLength(1);
    expect(raw[0].line).toBe(29);
    expect(calibratedSsrf(files)).toHaveLength(0);
  });

  it("drops a database-stored URL even with no validation guard (step 1 alone)", () => {
    const files = [f("app/api/segments/[id]/audio/route.ts", DB_STORED_NO_GUARD)];
    expect(ssrfFindings(files)).toHaveLength(1);
    expect(calibratedSsrf(files)).toHaveLength(0);
  });

  it("keeps a request-derived URL without validation (direct and variable-passing)", () => {
    for (const [name, src] of [
      ["direct", REQ_URL_DIRECT],
      ["variable", REQ_URL_VARIABLE],
    ]) {
      const files = [f("app/api/fetch/route.ts", src)];
      expect(ssrfFindings(files), name).toHaveLength(1);
      const out = calibratedSsrf(files);
      expect(out, name).toHaveLength(1);
      expect(out[0].unverified, name).toBeUndefined();
      expect(out[0].title, name).toContain("Outbound request built from user-controlled URL");
    }
  });

  it("drops a request-derived URL that passed a safe-URL guard (direct and flag)", () => {
    for (const [name, src] of [
      ["direct guard", VALIDATED_URL_GUARD],
      ["flag guard", VALIDATED_URL_FLAG],
    ]) {
      const files = [f("app/api/fetch/route.ts", src)];
      expect(ssrfFindings(files), name).toHaveLength(1);
      expect(calibratedSsrf(files), name).toHaveLength(0);
    }
  });

  it("routes to verification when the outbound call is not at the finding's line", () => {
    const files = [f("app/api/fetch/route.ts", REQ_URL_DIRECT)];
    const raw = ssrfFindings(files);
    expect(raw).toHaveLength(1);
    // A stale/wrong line: the filter cannot find the sink, so it cannot
    // establish the provenance.
    const stale = [{ ...raw[0], line: 999 }];
    const out = calibrateSsrfTaintFindings(stale, contentsOf(files));
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(SSRF_PROVENANCE_QUESTION);
  });

  it("drops the transport-probe SSRF on a DB-only callee (self-scan fix A2)", () => {
    const files = [
      f("server/routes/finalread-projects.ts", REBIND_ROUTE),
      f("server/finalread-projects.ts", REBIND_IMPL),
    ];
    const raw = transportSsrfFindings(files);
    expect(raw).toHaveLength(1);
    expect(raw[0].probe).toBe("SSRF");
    expect(raw[0].severity).toBe("high");
    expect(calibratedTransportSsrf(files)).toHaveLength(0);
  });

  it("keeps a real fetch with a request-derived URL (self-scan fix A2 positive control)", () => {
    const files = [f("app/api/fetch/route.ts", FETCH_REQ_URL)];
    expect(transportSsrfFindings(files)).toHaveLength(1);
    const out = calibratedTransportSsrf(files);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBeUndefined();
    expect(out[0].title).toBe("Server-side fetch with user-controlled URL");
  });

  it("routes an unresolvable *Request callee to verification (self-scan fix A2)", () => {
    const files = [f("server/routes/lookup.ts", UNRESOLVABLE_REQUEST_HELPER)];
    expect(transportSsrfFindings(files)).toHaveLength(1);
    const out = calibratedTransportSsrf(files);
    expect(out).toHaveLength(1);
    expect(out[0].unverified).toBe(true);
    expect(out[0].remediation).toBe(SSRF_CALLEE_QUESTION);
  });

  it("wiring: a full scan no longer carries the rebind SSRF as a liability", () => {
    const files = [
      f("server/routes/finalread-projects.ts", REBIND_ROUTE),
      f("server/finalread-projects.ts", REBIND_IMPL),
    ];
    const report = runPreFlightScan(files);
    expect(report.findings.filter((x) => x.probe === "SSRF")).toEqual([]);
  });

  it("wiring: a full scan no longer carries the audio-route SSRF as a liability", () => {
    const files = [
      f("app/api/segments/[id]/audio/route.ts", REEL_AUDIO),
      f("package.json", JSON.stringify({ name: "reelhouse", dependencies: { next: "16.0.0" } })),
    ];
    const r = runPreFlightScan(files, scan);
    expect(hasTitle(r, "Outbound request built from user-controlled URL")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item 4 — verification routing (no report-builder or score change)
// ---------------------------------------------------------------------------

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

const THREE_UNVERIFIED = [
  {
    severity: "high",
    probe: "API Route Auth",
    title: "Destructive HTTP handler (DELETE/PUT/PATCH) without auth check",
    file: "app/api/chapters/[id]/route.ts",
    line: 1,
    cwe: "CWE-306",
    evidence: "Destructive handler / mutation export found, no auth call in same file",
    remediation: DESTRUCTIVE_METHOD_QUESTION,
    unverified: true,
  },
  {
    severity: "critical",
    probe: "Supabase RLS Check",
    title: 'Table "books" missing ENABLE ROW LEVEL SECURITY',
    file: "migrations/0001_books.sql",
    line: 1,
    cwe: "CWE-284",
    evidence: "CREATE TABLE books",
    remediation: RLS_ACCESS_MODEL_QUESTION,
    unverified: true,
  },
  {
    severity: "high",
    probe: "Taint Flow",
    title: "Outbound request built from user-controlled URL (taint flow)",
    file: "app/api/segments/[id]/audio/route.ts",
    line: 31,
    cwe: "CWE-918",
    evidence: "Source: http-request-input at line 21 → Sink: fetch at line 31",
    remediation: SSRF_PROVENANCE_QUESTION,
    unverified: true,
  },
];

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

describe("Item 4 — verification routing", () => {
  it("an unverified finding of each of the three kinds never caps a score", () => {
    const files = [wf("server/auth.ts", AUTH_CODE)];
    const baseline = computeDeterministicAssessment(files, emptyPreflight());
    const withUnverified = computeDeterministicAssessment(files, {
      ...emptyPreflight(),
      findings: THREE_UNVERIFIED as PreFlightReport["findings"],
    });
    // No category score moves: the three unverified findings cap nothing.
    // (Their evidence lines still list the findings — they were flagged,
    // just not established — so compare scores, not the whole objects.)
    for (const key of Object.keys(baseline.categories) as (keyof typeof baseline.categories)[]) {
      expect(withUnverified.categories[key].score).toBe(baseline.categories[key].score);
    }
    expect(withUnverified.capsApplied.join(" ")).not.toMatch(/reconciliation/i);
    // And the same three findings, verified, DO cap (the guard is the
    // unverified flag, not the titles).
    const verified = THREE_UNVERIFIED.map((x) => ({ ...x, unverified: undefined }));
    const withVerified = computeDeterministicAssessment(files, {
      ...emptyPreflight(),
      findings: verified as PreFlightReport["findings"],
    });
    expect(withVerified.capsApplied.join(" ")).toMatch(/reconciliation/i);
    expect(
      withVerified.categories.authentication.score < baseline.categories.authentication.score ||
        withVerified.categories.security.score < baseline.categories.security.score
    ).toBe(true);
  });

  it("each of the three kinds renders in needsVerification with its specific question", () => {
    const r = buildFinalReadReport(baseReportInput({ findings: THREE_UNVERIFIED }));
    expect(r.liabilities).toHaveLength(0);
    expect(r.needsVerification).toHaveLength(3);
    const byTitle = new Map(r.needsVerification.map((i) => [i.title, i]));
    expect(
      byTitle.get("Destructive HTTP handler (DELETE/PUT/PATCH) without auth check")?.verification
        ?.howToCheck
    ).toBe(DESTRUCTIVE_METHOD_QUESTION);
    expect(
      byTitle.get('Table "books" missing ENABLE ROW LEVEL SECURITY')?.verification?.howToCheck
    ).toBe(RLS_ACCESS_MODEL_QUESTION);
    expect(
      byTitle.get("Outbound request built from user-controlled URL (taint flow)")?.verification
        ?.howToCheck
    ).toBe(SSRF_PROVENANCE_QUESTION);
    for (const item of r.needsVerification) {
      expect(item.verification?.whatEachAnswerMeans).toMatch(/becomes a liability/);
    }
  });
});
