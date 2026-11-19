// First-party calibration for the vendored Supabase-RLS per-table probe
// (server/preflight/vendor/lib/probes/database.js, probeSupabaseRLS,
// finalread-detector-precision-fix-spec.md Item 2 — APPROVED).
//
// The probe's client-reads half is correctly gated on Supabase-project
// status (database.js:92), but the per-table half (database.js:144) is
// not gated at all: for every `.sql` file it flags every `CREATE TABLE`
// without `ENABLE ROW LEVEL SECURITY` as CRITICAL, with the remediation
// "any client with the anon key can read and modify all rows". That claim
// is false for an app whose database is Neon Postgres reached only from
// the server (Drizzle + node-postgres Pool) — RLS is a control for
// databases clients can reach directly, and it is irrelevant there.
//
// This filter determines the database access model from the scanned files:
//   1. Supabase project (package, factory, or import) → KEEP the finding.
//   2. Server-side-only database (a server-side client is present, and
//      no Supabase and no client-accessible database) → DROP.
//   3. Cannot determine (migrations exist but no database client is
//      identifiable) → unverified: true, with the specific question in
//      remediation.
//
// Fail-closed: anything the filter cannot establish routes to
// verification; it never silently drops. The vendored probe is untouched
// — this is first-party, following the taint-path-filter.ts model. The
// other RLS findings (client-unprotected, permissive, permissive-check,
// disabled, security-definer) are already correctly gated or are a
// different finding, and pass through untouched.
export interface RlsFindingLike {
  id?: unknown;
  probe?: unknown;
  title?: unknown;
  file?: unknown;
  line?: unknown;
  severity?: unknown;
  evidence?: unknown;
  remediation?: unknown;
  unverified?: unknown;
}

const PER_TABLE_TITLE_RE = /^Table "[^"]*" missing ENABLE ROW LEVEL SECURITY$/;
const RLS_ID_PREFIX = "rls-";
// Findings that are already correctly gated (or a different finding) and
// must pass through untouched.
const EXCLUDED_ID_PREFIXES = [
  "rls-permissive-",
  "rls-permissive-check-",
  "rls-disabled-",
  "rls-client-unprotected-",
  "rls-securitydefiner-",
];

export const RLS_ACCESS_MODEL_QUESTION =
  "Does any client reach this database directly (for example a Supabase anon key shipped in the browser), or is it only reached from the server? Point at the client code or the connection setup that settles it.";

// The vendored gate (database.js: collectSupabaseHandles): the Supabase
// package in package.json or in a source file.
const SUPABASE_PACKAGE_RE = /@supabase\/(?:supabase-js|ssr|auth-helpers[\w-]*)/;
// A Supabase factory call or an import from a supabase path.
const SUPABASE_FACTORY_RE =
  /(?:createClient|createBrowserClient|createServerClient|createPagesBrowserClient|createPagesServerClient|createClientComponentClient|createServerComponentClient|createRouteHandlerClient|createMiddlewareClient)\s*\(/;
const SUPABASE_IMPORT_RE = /from\s*['"][^'"]*supabase[^'"]*['"]|require\(['"][^'"]*supabase[^'"]*['"]\)/;

// Server-side database clients (the DB_IMPL families in
// server/deterministic-score.ts:294, minus the client-side entries
// supabase / indexedDB / IDBDatabase, plus node-postgres Pool and Neon).
const SERVER_DB_RE =
  /(?:drizzle|prisma|mongoose|typeorm|sequelize|better-sqlite3|node:sqlite|kysely|mongodb|createPool|DataSource|@neondatabase|neon\(|pg\.Pool|new Pool|drizzle-orm|node-postgres)/i;

// Signals that a client can reach a database directly.
const CLIENT_DB_RE =
  /(?:@supabase\/|firebase\/firestore|firebase\/database|appwrite|convex\/react|pocketbase|@libsql\/client|turso)/i;

interface AccessModel {
  isSupabaseProject: boolean;
  hasServerDbClient: boolean;
  hasClientDb: boolean;
}

function determineAccessModel(files: Map<string, string>): AccessModel {
  let isSupabaseProject = false;
  let hasServerDbClient = false;
  let hasClientDb = false;
  for (const [path, content] of files) {
    if (/package\.json$/i.test(path) && SUPABASE_PACKAGE_RE.test(content)) {
      isSupabaseProject = true;
    }
    if (/\.[jt]sx?$/i.test(path) || /\.sql$/i.test(path)) {
      if (SUPABASE_PACKAGE_RE.test(content)) isSupabaseProject = true;
      if (SUPABASE_FACTORY_RE.test(content) || SUPABASE_IMPORT_RE.test(content)) {
        isSupabaseProject = true;
      }
    }
    if (SERVER_DB_RE.test(content)) hasServerDbClient = true;
    if (CLIENT_DB_RE.test(content)) hasClientDb = true;
  }
  return { isSupabaseProject, hasServerDbClient, hasClientDb };
}

function isPerTableRlsFinding(f: RlsFindingLike): boolean {
  if (typeof f.title !== "string" || !PER_TABLE_TITLE_RE.test(f.title)) return false;
  if (typeof f.id !== "string" || !f.id.startsWith(RLS_ID_PREFIX)) return false;
  for (const prefix of EXCLUDED_ID_PREFIXES) {
    if (f.id.startsWith(prefix)) return false;
  }
  return true;
}

export function calibrateRlsFindings<T extends RlsFindingLike>(
  findings: T[],
  files: Map<string, string>
): T[] {
  const model = determineAccessModel(files);
  const out: T[] = [];
  for (const f of findings) {
    if (!isPerTableRlsFinding(f)) {
      out.push(f);
      continue;
    }
    // Step 1 — Supabase project: RLS is the right control. Keep.
    if (model.isSupabaseProject) {
      out.push(f);
      continue;
    }
    // Step 2 — server-side-only database: RLS does not apply. Drop.
    if (model.hasServerDbClient && !model.hasClientDb) continue; // DROP
    // Step 3 — cannot determine the access model: verification.
    out.push({
      ...f,
      unverified: true,
      remediation: RLS_ACCESS_MODEL_QUESTION,
    });
  }
  return out;
}
