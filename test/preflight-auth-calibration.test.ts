// Ground-truth calibration for the PreFlight API Route Auth probe
// (server/preflight/vendor/lib/probes/auth.js -> probeAPIRouteAuth).
//
// Promoted 2026-10-12 from the standalone harness at
// workspace/your_files/gradevibes-probe-calibration/ (built 2026-10-07,
// re-verified 14/14 green 2026-10-12 before promotion).
//
// Why this exists: the probe is pattern-based, so the only honest way to
// know whether it catches real problems is to feed it route files whose
// correct answer is KNOWN and count catches (recall) vs. false alarms
// (precision). Every fixture below is labeled vulnerable/gated with an
// expected verdict.
//
// Each fixture runs as its OWN corpus (one or more files), so the
// corpus-level middleware downgrades in one fixture can't leak into another.
//
// If you change the probe, run this first: precision/recall moving tells you
// exactly what the change bought or broke.
import { describe, it, expect } from "vitest";
import { probeAPIRouteAuth } from "../server/preflight/vendor/lib/probes/auth.js";

interface FixtureFile {
  path: string;
  content: string;
}

interface Fixture {
  id: string;
  label: "vulnerable" | "gated";
  note: string;
  files: FixtureFile[];
  /** "fires" = probe must flag it; "quiet" = probe must stay silent */
  expected: "fires" | "quiet";
}

const fixtures: Fixture[] = [
  // ---------------------------------------------------------------- VULNERABLE (probe must fire)
  {
    id: "express-naked-refund",
    label: "vulnerable",
    note: "Express POST /api/admin/refund with no auth at all",
    files: [
      {
        path: "server/routes/refund.js",
        content: `
const db = require('../db');
app.post('/api/admin/refund', async (req, res) => {
  const { orderId, amount } = req.body;
  await db.refunds.insert({ orderId, amount });
  await db.orders.updateStatus(orderId, 'refunded');
  res.json({ ok: true });
});`,
      },
    ],
    expected: "fires",
  },
  {
    id: "next-delete-naked",
    label: "vulnerable",
    note: "Next pages/api DELETE handler with DB delete, no auth",
    files: [
      {
        path: "pages/api/users/delete.js",
        content: `
import db from '../../lib/db';
export async function DELETE(req) {
  const { userId } = await req.json();
  await db.users.delete(userId);
  return Response.json({ ok: true });
}`,
      },
    ],
    expected: "fires",
  },
  {
    id: "cf-worker-mutating",
    label: "vulnerable",
    note: "Cloudflare Worker POST handler running DELETE SQL via env.DB",
    files: [
      {
        path: "worker/index.js",
        content: `
export default {
  async fetch(request, env) {
    if (request.method === 'POST') {
      const { sessionId } = await request.json();
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      return new Response('deleted');
    }
    return new Response('ok');
  }
};`,
      },
    ],
    expected: "fires",
  },
  {
    id: "fastify-naked-billing",
    label: "vulnerable",
    note: "Fastify POST /api/billing/reset, no preHandler, no auth call",
    files: [
      {
        path: "api/billing/reset.js",
        content: `
import fastify from 'fastify';
const app = fastify();
app.post('/api/billing/reset', async (req, reply) => {
  const { userId } = req.body;
  await credits.set(userId, 0);
  return { ok: true };
});`,
      },
    ],
    expected: "fires",
  },
  {
    id: "sveltekit-naked-dashboard",
    label: "vulnerable",
    note: "SvelteKit +server endpoint on a /dashboard/ path, no auth",
    files: [
      {
        path: "src/routes/api/dashboard/+server.js",
        content: `
import { json } from '@sveltejs/kit';
import db from '$lib/db';
export const GET = async () => {
  const rows = await db.query('SELECT * FROM analytics');
  return json({ rows });
};`,
      },
    ],
    expected: "fires",
  },
  {
    id: "substring-trap",
    label: "vulnerable",
    note: "Route with NO auth but identifiers containing getUser fragments (targetUserId, preauthenticate, unauthenticated) — must NOT lull the probe",
    files: [
      {
        path: "server/routes/admin-purge.js",
        content: `
// Purge request targeting a single user account.
const targetUserId = sanitize(req.body.userId);
const preauthenticated = readHeader(req, 'x-purge-token');
if (preauthenticated && unauthenticated === false) {
  audit('purge requested');
}
app.post('/api/admin/purge', async (req, res) => {
  await db.users.delete(targetUserId);
  await db.sessions.deleteAll(targetUserId);
  res.json({ ok: true });
});`,
      },
    ],
    expected: "fires",
  },
  {
    id: "todo-acknowledged-gap",
    label: "vulnerable",
    note: "Sensitive route with NO auth but a TODO-auth comment — still a gap, just acknowledged (fires, downgraded)",
    files: [
      {
        path: "app/api/settings/route.ts",
        content: `
// TODO: add auth check before launch
export async function POST(req: Request) {
  const body = await req.json();
  await db.settings.update(body);
  return Response.json({ ok: true });
}`,
      },
    ],
    expected: "fires",
  },

  // -------------------------------------------------------------------- GATED (probe must stay quiet)
  {
    id: "express-middleware-arg",
    label: "gated",
    note: "Express route declaring authMiddleware as a middleware arg",
    files: [
      {
        path: "server/routes/refund.js",
        content: `
const db = require('../db');
app.post('/api/admin/refund', authMiddleware, async (req, res) => {
  const { orderId, amount } = req.body;
  await db.refunds.insert({ orderId, amount });
  res.json({ ok: true });
});`,
      },
    ],
    expected: "quiet",
  },
  {
    id: "next-getserversession",
    label: "gated",
    note: "Next route.ts gated by getServerSession at the top",
    files: [
      {
        path: "app/api/admin/users/route.ts",
        content: `
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response('Unauthorized', { status: 401 });
  const { userId } = await req.json();
  await db.users.delete(userId);
  return Response.json({ ok: true });
}`,
      },
    ],
    expected: "quiet",
  },
  {
    id: "custom-authenticate-helper",
    label: "gated",
    note: "Route gated by a custom authenticatePlatformKey() helper (the aa330b3 allowlist fix)",
    files: [
      {
        path: "server/routes/heal.js",
        content: `
const { authenticatePlatformKey } = require('../lib/platform-auth');
app.post('/api/heal', async (req, res) => {
  const key = await authenticatePlatformKey(req);
  if (!key) return res.status(401).json({ error: 'unauthorized' });
  const result = await runHeal(req.body);
  res.json(result);
});`,
      },
    ],
    expected: "quiet",
  },
  {
    id: "stripe-webhook",
    label: "gated",
    note: "Express webhook verifying a Stripe signature — signature IS the auth",
    files: [
      {
        path: "server/routes/webhook.js",
        content: `
const stripe = require('stripe')(process.env.STRIPE_SECRET);
app.post('/api/billing/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.WEBHOOK_SECRET);
  handleEvent(event);
  res.json({ received: true });
});`,
      },
    ],
    expected: "quiet",
  },
  {
    id: "supabase-getuser",
    label: "gated",
    note: "Handler verifying the Supabase JWT before touching the DB",
    files: [
      {
        path: "app/api/generate/route.ts",
        content: `
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.URL, process.env.ANON);
export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.split(' ')[1];
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return new Response('Unauthorized', { status: 401 });
  await spendCredits(user.id, 25);
  return Response.json({ ok: true });
});`,
      },
    ],
    expected: "quiet",
  },
  {
    id: "clerk-auth",
    label: "gated",
    note: "Next route using Clerk auth() from @clerk/nextjs",
    files: [
      {
        path: "app/api/admin/users/route.ts",
        content: `
import { auth } from '@clerk/nextjs';
export async function GET() {
  const { userId } = auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const users = await db.users.list();
  return Response.json({ users });
});`,
      },
    ],
    expected: "quiet",
  },
  {
    id: "oauth-callback",
    label: "gated",
    note: "Public OAuth callback endpoint — must not be flagged",
    files: [
      {
        path: "app/auth/callback/route.ts",
        content: `
export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get('code');
  const tokens = await exchangeCode(code);
  const res = new Response('ok');
  res.headers.set('Set-Cookie', 'session=' + tokens.session + '; HttpOnly');
  return res;
}`,
      },
    ],
    expected: "quiet",
  },
  {
    id: "nextauth-corpus-middleware",
    label: "gated",
    note: "Naked sensitive route, but a NextAuth v5 middleware.ts covers /api/* at the corpus level",
    files: [
      {
        path: "middleware.ts",
        content: `
import { auth } from './auth';
export default auth((req) => {
  // session required for all /api/* paths
});
export const config = { matcher: ['/api/:path*'] };`,
      },
      {
        path: "app/api/admin/reset/route.ts",
        content: `
export async function POST(req: Request) {
  await db.resetDemo();
  return Response.json({ ok: true });
}`,
      },
    ],
    expected: "quiet",
  },
];

// A telemetry-only authenticate*() helper suppresses the finding, and static
// analysis cannot distinguish it from a real gate. This is the documented
// blind spot from the 2026-10-06 hardening session — NOT fixable by regex
// alone (would need return-value/taint tracking). This test pins the CURRENT
// behavior: if you implement taint tracking and this starts firing, update
// this test deliberately — that's the test doing its job.
const blindSpot = {
  id: "authenticate-something-fake",
  note: "Route calling authenticateReportViewer() which only logs telemetry and never rejects",
  files: [
    {
      path: "server/routes/report.js",
      content: `
const { authenticateReportViewer } = require('../lib/reporting');
app.get('/api/admin/report', async (req, res) => {
  authenticateReportViewer(req); // telemetry only, never rejects
  const data = await db.analytics.all();
  res.json(data);
});`,
    },
  ],
};

function firedFor(fixture: { files: FixtureFile[] }): boolean {
  return probeAPIRouteAuth(fixture.files).length > 0;
}

describe("API Route Auth probe — ground-truth calibration", () => {
  for (const fx of fixtures) {
    it(`${fx.id} (${fx.label}, expect ${fx.expected})`, () => {
      const fired = firedFor(fx);
      if (fx.expected === "fires") {
        expect(fired, `${fx.id}: ${fx.note}`).toBe(true);
      } else {
        expect(fired, `${fx.id}: ${fx.note}`).toBe(false);
      }
    });
  }

  it("confusion matrix: precision and recall are both 1.0", () => {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const fx of fixtures) {
      const fired = firedFor(fx);
      if (fx.label === "vulnerable") {
        if (fired) tp++;
        else fn++;
      } else {
        if (fired) fp++;
        else tn++;
      }
    }
    expect({ tp, fp, tn, fn }).toEqual({ tp: 7, fp: 0, tn: 8, fn: 0 });
    expect(tp / (tp + fp)).toBe(1);
    expect(tp / (tp + fn)).toBe(1);
  });

  it("documented blind spot: telemetry-only authenticate*() helper stays quiet (known miss)", () => {
    // See the comment on `blindSpot` above. Do not "fix" this by weakening
    // the assertion — fix it by implementing taint tracking, then update
    // this test to expect the probe to fire.
    expect(firedFor(blindSpot)).toBe(false);
  });
});
