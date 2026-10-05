// Deterministic completeness scoring.
//
// The 10 rubric category scores, the missing-features list, and the total
// completeness score are computed here from scan evidence with pure,
// integer-arithmetic functions: no randomness, no wall-clock, no LLM.
// The same workspace always yields the same numbers.
//
// The LLM layer's job is to EXPLAIN these facts (reason strings citing the
// evidence anchors), never to invent or adjust them. server/routes/intelligence.ts
// injects this assessment as non-negotiable ground truth and overwrites any
// drifted scores after parsing the model response, so the served report is
// deterministic even when the model is not.
//
// Report structure is intentionally unchanged: the JSON shape the UI renders
// is identical; only the provenance of the numbers changes.

import { runDeterministicScan, type DeterministicAnalysis } from "./deterministic-scan";
import type { PreFlightReport, PreFlightFinding } from "../shared/preflight-types";
import type { WorkspaceFile } from "./workspace";

export const CATEGORY_KEYS = [
  "serverStarts",
  "authentication",
  "databaseLayer",
  "errorHandling",
  "coreLogic",
  "backgroundAutomation",
  "externalIntegrations",
  "security",
  "performance",
  "documentationVerified",
] as const;

export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  serverStarts: "Server starts correctly",
  authentication: "Authentication implemented",
  databaseLayer: "Database layer",
  errorHandling: "Error handling",
  coreLogic: "Core business / domain logic",
  backgroundAutomation: "Background automation",
  externalIntegrations: "External integrations",
  security: "Security",
  performance: "Performance",
  documentationVerified: "Documentation / verified",
};

export interface CategoryResult {
  score: number; // 0-10 integer, deterministic
  max: 10;
  evidence: string[]; // file:line anchors and signal descriptions
  note?: string; // e.g. "not in scope by design"
  applicable?: boolean; // false = N/A: the category does not apply to this project
  // by rule (not by model judgment) and is excluded from totals. Undefined
  // means applicable.
}

export interface MissingFeatureFact {
  feature: string;
  category: string; // human-readable category label
  evidence: string[];
}

export interface DeterministicAssessment {
  categories: Record<CategoryKey, CategoryResult>;
  missingFeatures: MissingFeatureFact[];
  completenessScore: number; // rescaled to 0-100 over the applicable categories
  applicableCount: number; // how many of the 10 categories apply (for "N of 10" display)
  capsApplied: string[];
  importMap: { path: string; imports: string[] }[]; // deterministic per-file import lists
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

interface FileSignals {
  path: string;
  content: string;
  lineCount: number;
  lower: string;
  analysis: DeterministicAnalysis;
  imports: string[];
}

function hasWord(haystack: string, pattern: RegExp): boolean {
  return pattern.test(haystack);
}

// Code-level signals (imports, declarations, route handlers): evidence that a
// capability is IMPLEMENTED, not merely mentioned.
const AUTH_IMPL = /(better-auth|next-auth|@clerk\/|passport|jsonwebtoken|createSession|verifyPassword|signIn\(|signOut\(|getServerSession|oauth)/i;
const AUTH_REF = /(sign\s?-?in|log\s?-?in|sign\s?-?up|create\s?account|forgot\s?password|reset\s?password)/i;
const DB_IMPL = /(drizzle|prisma|mongoose|typeorm|sequelize|better-sqlite3|node:sqlite|kysely|supabase|mongodb|createPool|DataSource)/i;
// Backend-as-a-service persistence: Firebase/Firestore/Realtime DB, Supabase client,
// Appwrite, Convex, PlanetScale, Neon, Turso/libSQL, Upstash, PocketBase. These are
// real persistence layers even though they ship no local schema/migration files.
const BAAS_IMPL = /(firebase\/firestore|firebase\/database|firebase-admin|getFirestore|getDatabase|@supabase\/supabase-js|createClient|appwrite|convex\/|planetscale|@planetscale|neon\(|@neondatabase|turso|@libsql|upstash|pocketbase)/i;
// BaaS config files (firebase.json, firestore.rules, supabase config, ...) prove the
// project is wired to a hosted persistence backend even when the client call sites
// live behind a wrapper the content scan cannot name.
const BAAS_CONFIG_PATH = /(firebase|firestore|supabase|appwrite)/i;
const DB_REF = /(database|migration|schema\.prisma|collection|table\s+users|persist)/i;
const PAYMENT_REF = /(stripe|checkout|payment|billing|subscription)/i;
const AUTOMATION_IMPL = /(node-cron|cron\.schedule|setInterval\s*\(|bullmq|inngest|trigger\.dev|new\s+Worker|webhook)/i;
const AUTOMATION_REF = /(webhook|cron|schedule|worker|queue|background\sjob)/i;
const EXT_SDK = /(stripe|openai|anthropic|@resend|twilio|sendgrid|elevenlabs|resend)/i;

function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path);
}

function isUiFile(path: string): boolean {
  return /\.(tsx|jsx|html|vue)$/.test(path);
}

interface WorkspaceSignals {
  files: FileSignals[];
  packageJson: any | null;
  totalEndpoints: number;
  totalStubs: number;
  totalTodos: number;
  tryCatchCount: number;
  totalCodeLines: number;
}

const API_ROUTE_FILE =
  /(^|\/)app\/api\/.+\/route\.(ts|tsx|js|jsx)$|(^|\/)pages\/api\/.+\.(ts|tsx|js|jsx)$|(^|\/)server\/routes\/.+\.(ts|js)$|(^|\/)routes\/.+\.(ts|js)$/;

// Vendored, generated, or third-party code is not the user's work: its TODOs
// and keyword hits would otherwise pollute every category.
const VENDORED_PATH =
  /(^|\/)(node_modules|dist|build|vendor|\.git|\.next|coverage)\/|__pycache__|\.min\.(js|css)$|\.bundle\.js$/i;

// Deterministic import extraction: module specifiers from import/export-from/
// require()/dynamic-import statements, with comments stripped so commented-out
// code never pollutes the map. The LLM-written application map must reproduce
// these lists exactly (rule 0 in the intelligence prompt).
const IMPORT_SPEC_RE =
  /(?:import\s+(?:[^'"`]*?\s+from\s+)?|export\s+(?:[^'"`]*?\s+from\s+)?|require\s*\(\s*|import\s*\(\s*)["'`]([^"'`]+)["'`]/g;

export function extractImports(content: string): string[] {
  const noComments = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  IMPORT_SPEC_RE.lastIndex = 0;
  while ((m = IMPORT_SPEC_RE.exec(noComments)) !== null) {
    const spec = m[1].trim();
    if (spec && !seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
  }
  return out;
}

// Resolve a relative import specifier ("./x", "../y") against the importing
// file to a workspace path, trying the usual TS/JS extension probes. Returns
// null for bare package specifiers or unresolvable paths.
export function resolveWorkspaceImport(
  importerPath: string,
  spec: string,
  knownPaths: Set<string>
): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = importerPath.includes("/") ? importerPath.slice(0, importerPath.lastIndexOf("/")) : "";
  const segs: string[] = [];
  for (const part of ((dir ? dir + "/" : "") + spec).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  const base = segs.join("/");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
  for (const c of candidates) if (knownPaths.has(c)) return c;
  return null;
}

function collectSignals(files: WorkspaceFile[]): WorkspaceSignals {
  const sorted = [...files]
    .filter((f) => !VENDORED_PATH.test(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out: FileSignals[] = [];
  let packageJson: any | null = null;
  let totalEndpoints = 0;
  let totalStubs = 0;
  let totalTodos = 0;
  let tryCatchCount = 0;
  let totalCodeLines = 0;

  for (const f of sorted) {
    const content = f.content || "";
    const lower = content.toLowerCase();
    let analysis: DeterministicAnalysis;
    try {
      analysis = runDeterministicScan(content, f.path);
    } catch {
      continue; // never let signal extraction break scoring
    }
    totalEndpoints += analysis.endpointCount;
    // Framework-conventional API route files (Next.js app/api/**/route.ts,
    // pages/api/**, Express route modules): the regex endpoint counter is
    // Express-registration oriented and undercounts these.
    if (API_ROUTE_FILE.test(f.path)) totalEndpoints += 1;
    totalStubs += analysis.stubCount;
    totalTodos += analysis.todoCount;
    if (isCodeFile(f.path)) {
      totalCodeLines += f.lineCount;
      const m = content.match(/\btry\s*\{/g);
      if (m) tryCatchCount += m.length;
    }
    if (/(^|\/)package\.json$/.test(f.path) && !packageJson) {
      try {
        packageJson = JSON.parse(content);
      } catch {
        packageJson = null;
      }
    }
    out.push({ path: f.path, content, lineCount: f.lineCount, lower, analysis, imports: extractImports(content) });
  }
  return { files: out, packageJson, totalEndpoints, totalStubs, totalTodos, tryCatchCount, totalCodeLines };
}

function fileExists(sig: WorkspaceSignals, ...names: string[]): string | null {
  for (const f of sig.files) {
    for (const n of names) {
      if (f.path === n || f.path.endsWith("/" + n)) return f.path;
    }
  }
  return null;
}

function anyFile(sig: WorkspaceSignals, pred: (f: FileSignals) => boolean): FileSignals | null {
  for (const f of sig.files) if (pred(f)) return f;
  return null;
}

function countFiles(sig: WorkspaceSignals, pred: (f: FileSignals) => boolean): number {
  let n = 0;
  for (const f of sig.files) if (pred(f)) n++;
  return n;
}

function depNames(sig: WorkspaceSignals): string[] {
  const pkg = sig.packageJson;
  if (!pkg) return [];
  return Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
}

function anchor(path: string, lines: string): string {
  return `${path}:${lines}`;
}

// ---------------------------------------------------------------------------
// Per-category deterministic rubrics. Each returns an integer 0-10 plus the
// evidence anchors that justify it. Bands are fixed; there is no sampling.
// ---------------------------------------------------------------------------

function scoreServerStarts(sig: WorkspaceSignals): CategoryResult {
  const evidence: string[] = [];
  const deps = depNames(sig);
  const isNext = deps.includes("next") || !!fileExists(sig, "app/layout.tsx", "app/page.tsx", "pages/index.tsx");
  const hasIndexHtml = fileExists(sig, "index.html");
  const hasMain = fileExists(sig, "src/main.tsx", "src/main.jsx", "src/index.tsx");
  const hasAppTsx = fileExists(sig, "src/App.tsx", "app/page.tsx", "pages/index.tsx");
  const serverTs = fileExists(sig, "server.ts", "server/index.ts", "src/server.ts");
  const listens = serverTs
    ? sig.files.some((f) => f.path === serverTs && /\.listen\s*\(/.test(f.content))
    : false;

  if (isNext) {
    const layout = fileExists(sig, "app/layout.tsx", "pages/_app.tsx");
    const page = fileExists(sig, "app/page.tsx", "pages/index.tsx");
    if (layout && page) {
      evidence.push(`${layout} + ${page} (Next.js front door present)`);
      return { score: 10, max: 10, evidence };
    }
    evidence.push("Next.js app without app/page.tsx or app/layout.tsx — no front door (CAP A)");
    return { score: 2, max: 10, evidence, note: "missing-front-door" };
  }

  const isFrontend = hasIndexHtml || hasMain || hasAppTsx || deps.includes("react") || deps.includes("vite");
  if (isFrontend) {
    if ((hasIndexHtml || hasMain) && hasAppTsx) {
      evidence.push(`${hasIndexHtml || hasMain} + ${hasAppTsx} (frontend entrypoint wired)`);
      return { score: 10, max: 10, evidence };
    }
    evidence.push("frontend framework present but no routed front door (CAP A)");
    return { score: 2, max: 10, evidence, note: "missing-front-door" };
  }

  if (serverTs) {
    if (listens) {
      evidence.push(`${serverTs} calls .listen() (server entrypoint wired)`);
      return { score: 10, max: 10, evidence };
    }
    evidence.push(`${serverTs} present but no .listen() call found`);
    return { score: 4, max: 10, evidence };
  }

  evidence.push("no recognizable server or frontend entrypoint");
  return { score: 2, max: 10, evidence };
}

function scoreAuthentication(sig: WorkspaceSignals): CategoryResult {
  const evidence: string[] = [];
  const implFiles = sig.files.filter(
    (f) =>
      isCodeFile(f.path) &&
      (hasWord(f.content, AUTH_IMPL) || /(^|\/)(auth|session|login|signup|sign-in)(\.|-|_|\/)/i.test(f.path))
  );
  // A path match alone is weak; require a code-level signal or 2+ auth files.
  const strong = implFiles.filter((f) => hasWord(f.content, AUTH_IMPL));
  const implemented = strong.length > 0 || implFiles.length >= 2;

  if (implemented) {
    const names = implFiles.slice(0, 4).map((f) => f.path);
    evidence.push(`${names.join(", ")} (auth implementation signals)`);
    const stubbed = implFiles.some((f) => f.analysis.stubCount > 0 || f.analysis.todoCount > 0);
    if (stubbed) {
      evidence.push("auth code contains stubs/TODOs");
      return { score: 5, max: 10, evidence };
    }
    return { score: 10, max: 10, evidence };
  }

  const referenced = anyFile(sig, (f) => isUiFile(f.path) && hasWord(f.content, AUTH_REF));
  if (referenced) {
    evidence.push(`${referenced.path} references sign-in/up with no auth backend (dangling)`);
    return { score: 2, max: 10, evidence, note: "dangling-auth" };
  }
  evidence.push("no auth code and no auth references — not in scope by design");
  return { score: 10, max: 10, evidence, note: "not-in-scope" };
}

function scoreDatabaseLayer(sig: WorkspaceSignals): CategoryResult {
  const evidence: string[] = [];
  const implFiles = sig.files.filter(
    (f) => isCodeFile(f.path) && (hasWord(f.content, DB_IMPL) || hasWord(f.content, BAAS_IMPL))
  );
  const baasCode = implFiles.some((f) => hasWord(f.content, BAAS_IMPL) && !hasWord(f.content, DB_IMPL));
  // BaaS config present (e.g. firebase-applet-config.json) even if the client call
  // sites are wrapped opaquely: persistence exists, usage unverified.
  const baasConfig = sig.files.find((f) => !isCodeFile(f.path) && BAAS_CONFIG_PATH.test(f.path));
  const schemaFiles = sig.files.filter((f) => /(schema|migration|models?)\//i.test(f.path) || /schema\.(ts|js|prisma|sql)$/i.test(f.path));

  if (implFiles.length > 0) {
    const names = implFiles.slice(0, 4).map((f) => f.path);
    evidence.push(`${names.join(", ")} (${baasCode ? "BaaS" : "database"} client usage)`);
    if (baasCode) {
      evidence.push("document/BaaS store — schema files not expected");
    } else if (schemaFiles.length > 0) {
      evidence.push(`${schemaFiles[0].path} (schema/migration present)`);
    } else {
      evidence.push("no schema/migration file detected");
    }
    const stubbed = implFiles.some((f) => f.analysis.stubCount > 0);
    if (stubbed) {
      evidence.push("database code contains stubs");
      return { score: 5, max: 10, evidence };
    }
    return { score: baasCode || schemaFiles.length > 0 ? 10 : 8, max: 10, evidence };
  }

  if (baasConfig) {
    evidence.push(`${baasConfig.path} (BaaS persistence configured; client usage not detected in scanned files)`);
    return { score: 7, max: 10, evidence };
  }

  const referenced = anyFile(sig, (f) => hasWord(f.content, DB_REF));
  if (referenced) {
    evidence.push(`${referenced.path} references persistence with no database code (dangling)`);
    return { score: 2, max: 10, evidence, note: "dangling-db" };
  }
  evidence.push("no database code and no persistence references — not in scope by design");
  return { score: 10, max: 10, evidence, note: "not-in-scope" };
}

function scoreErrorHandling(sig: WorkspaceSignals): CategoryResult {
  const evidence: string[] = [];
  const density = sig.totalCodeLines > 0 ? (sig.tryCatchCount / sig.totalCodeLines) * 1000 : 0;
  const boundary = anyFile(
    sig,
    (f) => /ErrorBoundary|error\.tsx|onError/i.test(f.path) || /app\.use\(\s*\(err/i.test(f.content)
  );
  evidence.push(`${sig.tryCatchCount} try/catch blocks across ${sig.totalCodeLines} code lines`);
  if (boundary) evidence.push(`${boundary.path} (error boundary/middleware)`);

  let score: number;
  if (boundary && density >= 3) score = 10;
  else if (density >= 8 || (boundary && density >= 1)) score = 9;
  else if (density >= 4) score = 7;
  else if (density >= 1.5) score = 5;
  else if (density > 0) score = 3;
  else score = 2;
  return { score, max: 10, evidence };
}

function scoreCoreLogic(sig: WorkspaceSignals): CategoryResult {
  const evidence: string[] = [];
  const codeFiles = sig.files.filter((f) => isCodeFile(f.path));
  const substantive = codeFiles.filter(
    (f) => f.lineCount >= 40 && f.analysis.stubCount === 0 && !/(\.test\.|\.spec\.|__tests__)/i.test(f.path)
  );
  const ratio = codeFiles.length > 0 ? substantive.length / codeFiles.length : 0;
  evidence.push(`${substantive.length}/${codeFiles.length} code files are substantive (40+ lines, no stubs)`);
  if (sig.totalStubs > 0) evidence.push(`${sig.totalStubs} stub markers detected`);
  if (sig.totalTodos > 0) evidence.push(`${sig.totalTodos} TODO/FIXME markers detected`);

  let score = Math.round(ratio * 10);
  if (codeFiles.length === 0) score = 1;
  else if (score < 2) score = 2;
  return { score, max: 10, evidence };
}

function scoreBackgroundAutomation(sig: WorkspaceSignals): CategoryResult {
  const evidence: string[] = [];
  const impl = anyFile(sig, (f) => isCodeFile(f.path) && hasWord(f.content, AUTOMATION_IMPL));
  if (impl) {
    evidence.push(`${impl.path} (scheduler/worker/webhook implementation)`);
    return { score: 10, max: 10, evidence };
  }
  const referenced = anyFile(sig, (f) => hasWord(f.content, AUTOMATION_REF) || hasWord(f.content, PAYMENT_REF));
  // A scheduler/queue/worker dependency with no code usage yet still counts
  // as "in scope" — the rule is "no such dependency anywhere", not "no import".
  const automationDep = depNames(sig).some((d) => /(cron|bull|queue|worker|schedule|inngest|agenda)/i.test(d));
  if (referenced || automationDep) {
    if (automationDep && !referenced) evidence.push(`package.json depends on automation (${depNames(sig).filter((d) => /(cron|bull|queue|worker|schedule|inngest|agenda)/i.test(d)).join(", ")}) with no implementation`);
    else evidence.push(`${referenced!.path} references automation/webhooks with no implementation`);
    return { score: 3, max: 10, evidence, note: "dangling-automation" };
  }
  // Rule-based N/A (never model judgment): no scheduler/queue/worker/cron
  // implementation in code AND no such reference or dependency anywhere.
  // Scoring this 10/10 would read as "excellent automation" for an app that
  // has none; it is excluded from the total instead, and the total is
  // rescaled over the applicable categories.
  evidence.push("no scheduler, queue, worker, cron, or webhook code or dependencies found — not applicable");
  return { score: 0, max: 10, evidence, note: "not-applicable", applicable: false };
}

function scoreExternalIntegrations(sig: WorkspaceSignals): CategoryResult {
  const evidence: string[] = [];
  const sdkFiles = sig.files.filter((f) => isCodeFile(f.path) && hasWord(f.content, EXT_SDK));
  const externalFetches = sig.files.filter((f) => /fetch\(\s*[`'"]https?:\/\//i.test(f.content));

  if (sdkFiles.length > 0 || externalFetches.length > 0) {
    const names = [...sdkFiles, ...externalFetches].slice(0, 4).map((f) => f.path);
    evidence.push(`${names.join(", ")} (external integration usage)`);
    const stubbed = sdkFiles.some((f) => f.analysis.stubCount > 0 || f.analysis.todoCount > 0);
    if (stubbed) {
      evidence.push("integration code contains stubs/TODOs");
      return { score: 5, max: 10, evidence };
    }
    return { score: 10, max: 10, evidence };
  }

  const referenced = anyFile(sig, (f) => hasWord(f.content, PAYMENT_REF));
  if (referenced) {
    evidence.push(`${referenced.path} references payments/integrations with no implementation`);
    return { score: 3, max: 10, evidence, note: "dangling-integration" };
  }
  evidence.push("no external integrations referenced — not in scope by design");
  return { score: 10, max: 10, evidence, note: "not-in-scope" };
}

function scoreSecurity(sig: WorkspaceSignals, preflight: PreFlightReport): CategoryResult {
  const evidence: string[] = [];
  if (preflight.failed || preflight.probeFailures.length > 0) {
    evidence.push("deterministic security scan incomplete — score withheld at neutral");
    return { score: 5, max: 10, evidence, note: "scan-incomplete" };
  }
  const bySeverity = [...preflight.findings].sort((a, b) => {
    const order = ["critical", "high", "medium", "low", "info"];
    return order.indexOf(a.severity) - order.indexOf(b.severity);
  });
  for (const f of bySeverity.slice(0, 5)) {
    evidence.push(`${f.file}${f.line ? ":" + f.line : ""} [${f.severity}] ${f.title}`);
  }
  if (preflight.findings.length === 0) evidence.push("no findings across all probes");
  // The PreFlight score is itself deterministic (0-100); map it onto the
  // 10-point category so the rubric and the scan panel can never disagree.
  const score = Math.max(0, Math.min(10, Math.round(preflight.score / 10)));
  evidence.push(`PreFlight deterministic score ${preflight.score}/100 → ${score}/10`);
  return { score, max: 10, evidence };
}

function scorePerformance(sig: WorkspaceSignals): CategoryResult {
  const evidence: string[] = [];
  let score = 7;
  const pkg = sig.packageJson;
  if (pkg?.scripts?.build) {
    score += 1;
    evidence.push("package.json build script present");
  }
  const splitting = anyFile(sig, (f) => /React\.lazy|Suspense|import\s*\(/.test(f.content));
  if (splitting) {
    score += 1;
    evidence.push(`${splitting.path} (code-splitting/lazy loading)`);
  }
  const huge = sig.files.find((f) => f.lineCount > 5000);
  if (huge) {
    score -= 2;
    evidence.push(`${huge.path} exceeds 5000 lines (bundle/maintainability risk)`);
  } else {
    evidence.push("no oversized files");
  }
  score = Math.max(3, Math.min(10, score));
  return { score, max: 10, evidence };
}

function scoreDocumentation(sig: WorkspaceSignals): CategoryResult {
  const evidence: string[] = [];
  let score = 0;
  const readme = sig.files.find((f) => /(^|\/)README\.md$/i.test(f.path));
  if (readme && readme.lineCount > 50) {
    score += 4;
    evidence.push(`README.md (${readme.lineCount} lines, substantive)`);
  } else if (readme && readme.lineCount > 15) {
    score += 3;
    evidence.push(`README.md (${readme.lineCount} lines)`);
  } else if (readme) {
    score += 1;
    evidence.push("README.md present but thin");
  } else {
    evidence.push("no README.md");
  }

  let commentLines = 0;
  let typeHits = 0;
  for (const f of sig.files) {
    if (!isCodeFile(f.path)) continue;
    const lines = f.content.split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) commentLines++;
    }
    if (/(interface\s+\w+|type\s+\w+\s*=)/.test(f.content)) typeHits++;
  }
  const commentRatio = sig.totalCodeLines > 0 ? commentLines / sig.totalCodeLines : 0;
  const commentPts = commentRatio >= 0.15 ? 3 : commentRatio >= 0.08 ? 2 : commentRatio >= 0.03 ? 1 : 0;
  score += commentPts;
  evidence.push(`comment density ${(commentRatio * 100).toFixed(1)}% → +${commentPts}`);
  const typePts = typeHits >= 5 ? 3 : typeHits >= 2 ? 2 : typeHits >= 1 ? 1 : 0;
  score += typePts;
  evidence.push(`${typeHits} files with TypeScript interfaces/type aliases → +${typePts}`);
  return { score: Math.min(10, score), max: 10, evidence };
}

// ---------------------------------------------------------------------------
// Hard caps (previously LLM-enforced, now computed). Applied in CAP order.
// ---------------------------------------------------------------------------

function stripePresentWithoutWebhook(sig: WorkspaceSignals): boolean {
  const stripeFile = anyFile(sig, (f) => /stripe/i.test(f.content));
  if (!stripeFile) return false;
  const webhook = sig.files.some(
    (f) => /webhook/i.test(f.path) || /webhook/i.test(f.content)
  );
  return !webhook;
}

// Largest-remainder scaling: ints that sum to EXACTLY `cap`, distributed
// deterministically (fractional part desc, ties broken by CATEGORY_KEYS order).
function scaleToCap(
  scores: Record<CategoryKey, number>,
  cap: number,
  keys: readonly CategoryKey[]
): Record<CategoryKey, number> {
  const total = keys.reduce((n, k) => n + scores[k], 0);
  if (total <= cap || total === 0) return { ...scores };
  const exact = keys.map((k) => ({ k, v: (scores[k] * cap) / total }));
  const floored = exact.map((e) => ({ ...e, f: Math.floor(e.v), r: e.v - Math.floor(e.v) }));
  let remainder = cap - floored.reduce((n, e) => n + e.f, 0);
  floored.sort((a, b) => b.r - a.r || CATEGORY_KEYS.indexOf(a.k) - CATEGORY_KEYS.indexOf(b.k));
  const out = {} as Record<CategoryKey, number>;
  for (const e of floored) out[e.k] = e.f;
  for (const e of floored) {
    if (remainder <= 0) break;
    out[e.k] += 1;
    remainder -= 1;
  }
  // Preserve any keys not being scaled (e.g. N/A categories at 0).
  for (const k of CATEGORY_KEYS) if (!(k in out)) out[k] = scores[k];
  return out;
}

// ---------------------------------------------------------------------------
// Missing features, derived from evidence. Ordered deterministically:
// structural gaps first, then stubs/TODOs by path and line.
// ---------------------------------------------------------------------------

function categoryForPath(path: string, content: string): string {
  const p = path.toLowerCase();
  const c = content.toLowerCase();
  if (/auth|login|session|user/i.test(p) || /auth|login/.test(c.slice(0, 200))) return CATEGORY_LABELS.authentication;
  if (/stripe|payment|billing|checkout|webhook/i.test(p)) return CATEGORY_LABELS.externalIntegrations;
  if (/db|database|prisma|drizzle|migration|schema/i.test(p)) return CATEGORY_LABELS.databaseLayer;
  return CATEGORY_LABELS.coreLogic;
}

function computeMissingFeatures(
  sig: WorkspaceSignals,
  categories: Record<CategoryKey, CategoryResult>
): MissingFeatureFact[] {
  const out: MissingFeatureFact[] = [];
  const seen = new Set<string>();
  const push = (feature: string, category: string, evidence: string[]) => {
    const key = feature.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ feature, category, evidence });
  };

  // Structural gaps (highest priority).
  if (stripePresentWithoutWebhook(sig)) {
    const f = anyFile(sig, (x) => /stripe/i.test(x.content));
    push("Add Stripe webhook handler", CATEGORY_LABELS.externalIntegrations, [
      `${f!.path} (Stripe referenced, no webhook route found)`,
    ]);
  }
  const authCat = categories.authentication;
  if (authCat.note === "dangling-auth") {
    push("Implement authentication backend", CATEGORY_LABELS.authentication, authCat.evidence);
  }
  const dbCat = categories.databaseLayer;
  if (dbCat.note === "dangling-db") {
    push("Add database persistence layer", CATEGORY_LABELS.databaseLayer, dbCat.evidence);
  }
  const autoCat = categories.backgroundAutomation;
  if (autoCat.note === "dangling-automation") {
    push("Implement missing background automation (scheduler/worker/webhook)", CATEGORY_LABELS.backgroundAutomation, autoCat.evidence);
  }

  // Imported-but-empty files: the module resolves, the named import does not —
  // the build breaks. Worse than an unused placeholder, so this outranks stubs.
  const knownPaths = new Set(sig.files.map((f) => f.path));
  const importTargets = new Map<string, string[]>();
  for (const f of sig.files) {
    for (const spec of f.imports) {
      const target = resolveWorkspaceImport(f.path, spec, knownPaths);
      if (target && target !== f.path) {
        const list = importTargets.get(target) ?? [];
        if (!list.includes(f.path)) list.push(f.path);
        importTargets.set(target, list);
      }
    }
  }
  for (const [target, importers] of [...importTargets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const tf = sig.files.find((x) => x.path === target);
    if (tf && tf.content.trim().length === 0) {
      push(
        "Implement " + target + " \u2014 imported by " + importers.join(", ") + " but the file is empty (breaks the build)",
        CATEGORY_LABELS.coreLogic,
        [target + " is empty; imported by " + importers.join(", ")]
      );
    }
  }

  // Stubbed implementations and TODOs, file by file, line by line.
  const stubItems: { path: string; line: string; code: string }[] = [];
  const todoItems: { path: string; line: string; code: string }[] = [];
  for (const f of sig.files) {
    for (const s of f.analysis.stubs) stubItems.push({ path: f.path, line: s.lines, code: s.code.trim().slice(0, 80) });
    for (const t of f.analysis.todos) todoItems.push({ path: f.path, line: t.lines, code: t.code.trim().slice(0, 80) });
  }
  const byPathLine = (a: { path: string; line: string }, b: { path: string; line: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : parseInt(a.line) - parseInt(b.line) || 0;
  stubItems.sort(byPathLine);
  todoItems.sort(byPathLine);

  for (const s of stubItems.slice(0, 8)) {
    const f = sig.files.find((x) => x.path === s.path)!;
    push(`Finish stubbed implementation in ${s.path}`, categoryForPath(s.path, s.code), [
      anchor(s.path, s.line),
    ]);
    void f;
  }
  for (const t of todoItems.slice(0, 8)) {
    push(`Resolve TODO in ${t.path}`, categoryForPath(t.path, t.code), [anchor(t.path, t.line)]);
  }

  return out.slice(0, 15);
}

// ---------------------------------------------------------------------------
// Finding↔category reconciliation ("both checks" rule).
//
// A critical/high security finding must be reflected in every rubric
// category it touches: "Authentication implemented 10/10" can never sit
// next to a critical "no auth check" finding. The security category already
// reflects all findings through the PreFlight score mapping; the other
// categories are scored from implementation signals alone, so without this
// pass they can contradict the findings. A mapped finding caps its
// category: critical → at most 4/10, high → at most 6/10. Runs after CAP C
// and before the CAP A/B total scaling, so the scaled total respects the
// reconciled categories.
// ---------------------------------------------------------------------------

/** Rubric categories (other than security) that one finding touches. */
function findingCategories(f: PreFlightFinding): CategoryKey[] {
  const cats = new Set<CategoryKey>();
  // Structured signals beat keywords when the engine provides them.
  const owasp = (f.owasp ?? []).join(" ").toUpperCase();
  const cwe = f.cwe ?? "";
  // A07 identification/authentication failures; CWE-287/306/862/863 auth*;
  // A01 broken access control lands in the closest rubric bucket.
  if (/A0?7/.test(owasp) || /\b(287|306|862|863)\b/.test(cwe) || /A0?1/.test(owasp)) {
    cats.add("authentication");
  }
  const text = `${f.title} ${f.probe} ${f.file}`.toLowerCase();
  if (
    /auth|login|log-?in|sign-?in|session|jwt|password|credential|unauthenticated|missing auth|without auth|no auth/.test(
      text
    )
  ) {
    cats.add("authentication");
  }
  if (/stripe|payment|billing|checkout|webhook/.test(text)) cats.add("externalIntegrations");
  if (/sql injection|\bprisma\b|\bdrizzle\b|mongodb|postgres|supabase|\brls\b|row level security|service_role/.test(text)) cats.add("databaseLayer");
  return [...cats];
}

function reconcileFindingCaps(
  categories: Record<CategoryKey, CategoryResult>,
  preflight: PreFlightReport,
  capsApplied: string[]
): void {
  // Findings from a failed or partial scan are unreliable; scoreSecurity
  // already withholds at neutral in that case.
  if (preflight.failed || preflight.probeFailures.length > 0) return;
  const worst = new Map<CategoryKey, { severity: "critical" | "high"; title: string }>();
  for (const f of preflight.findings) {
    if (f.severity !== "critical" && f.severity !== "high") continue;
    for (const k of findingCategories(f)) {
      const prev = worst.get(k);
      if (!prev || (f.severity === "critical" && prev.severity === "high")) {
        worst.set(k, { severity: f.severity, title: f.title });
      }
    }
  }
  for (const [k, hit] of [...worst.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (categories[k].applicable === false) continue; // N/A categories are excluded from scoring
    const cap = hit.severity === "critical" ? 4 : 6;
    const before = categories[k].score;
    if (before > cap) {
      categories[k] = {
        ...categories[k],
        score: cap,
        evidence: [
          ...categories[k].evidence,
          `Reconciled: ${hit.severity} finding "${hit.title}" caps ${CATEGORY_LABELS[k]} at ${cap}/10`,
        ],
      };
      capsApplied.push(
        `Finding/category reconciliation: ${hit.severity} finding "${hit.title}" caps ${CATEGORY_LABELS[k]} at ${cap}/10`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function computeDeterministicAssessment(
  files: WorkspaceFile[],
  preflight: PreFlightReport
): DeterministicAssessment {
  const sig = collectSignals(files);
  const capsApplied: string[] = [];

  const categories: Record<CategoryKey, CategoryResult> = {
    serverStarts: scoreServerStarts(sig),
    authentication: scoreAuthentication(sig),
    databaseLayer: scoreDatabaseLayer(sig),
    errorHandling: scoreErrorHandling(sig),
    coreLogic: scoreCoreLogic(sig),
    backgroundAutomation: scoreBackgroundAutomation(sig),
    externalIntegrations: scoreExternalIntegrations(sig),
    security: scoreSecurity(sig, preflight),
    performance: scorePerformance(sig),
    documentationVerified: scoreDocumentation(sig),
  };

  // CAP C (broken loop / missing webhooks): deterministic deduction.
  if (stripePresentWithoutWebhook(sig)) {
    for (const k of ["externalIntegrations", "databaseLayer"] as const) {
      const before = categories[k].score;
      categories[k] = {
        ...categories[k],
        score: Math.max(0, before - 4),
        evidence: [...categories[k].evidence, "CAP C: Stripe present without webhook handler (−4)"],
      };
    }
    capsApplied.push("CAP C (Stripe without webhook: −4 externalIntegrations, −4 databaseLayer)");
  }

  // Finding↔category reconciliation: a critical/high finding caps every
  // rubric category it touches, so a 10/10 can never sit next to a
  // critical finding in the same category.
  reconcileFindingCaps(categories, preflight, capsApplied);

  // CAP A / CAP B scale the total; largest-remainder keeps ints exact.
  // N/A categories are excluded from scaling entirely (they stay 0 and the
  // applicable set is rescaled instead).
  const applicableKeys = CATEGORY_KEYS.filter((k) => categories[k].applicable !== false);
  let scores: Record<CategoryKey, number> = Object.fromEntries(
    CATEGORY_KEYS.map((k) => [k, categories[k].score])
  ) as Record<CategoryKey, number>;

  // A package.json dependency list is corroboration, not a requirement: a
  // workspace of .tsx files importing 'react' with no package.json at all is
  // still a frontend project, and its missing front door still caps the total.
  const looksLikeFrontend =
    depNames(sig).includes("next") ||
    depNames(sig).includes("react") ||
    depNames(sig).includes("vite") ||
    sig.files.some(
      (f) => /\.(tsx|jsx)$/.test(f.path) && f.imports.some((spec) => spec === "react" || spec === "react-dom" || spec === "next")
    );
  const missingFrontDoor = categories.serverStarts.note === "missing-front-door" && looksLikeFrontend;
  // CAP A / CAP B bound the final 0-100 grade. Category scores are scaled
  // first (so the rubric stays proportional), then the rescaled total is
  // clamped to the cap.
  let totalCap: number | null = null;
  if (missingFrontDoor) {
    scores = scaleToCap(scores, 30, applicableKeys);
    totalCap = 30;
    capsApplied.push("CAP A (missing front door: total capped at 30)");
  } else if (sig.totalEndpoints <= 1) {
    const claimsApi = sig.files.some(
      (f) => hasWord(f.content, AUTH_REF) || hasWord(f.content, DB_REF) || hasWord(f.content, PAYMENT_REF)
    );
    // A reference is only a hollow claim when the capability is actually
    // missing: real auth/db/integration implementations (Firebase included)
    // are evidence of a backend, not of an unfinished one.
    const hollowClaim = (["authentication", "databaseLayer", "externalIntegrations"] as const).some((k) =>
      (categories[k].note ?? "").startsWith("dangling")
    );
    if (claimsApi && hollowClaim && sig.files.length > 5) {
      scores = scaleToCap(scores, 45, applicableKeys);
      totalCap = 45;
      capsApplied.push("CAP B (single-endpoint API surface: total capped at 45)");
    }
  }

  for (const k of CATEGORY_KEYS) {
    if (scores[k] !== categories[k].score) {
      categories[k] = { ...categories[k], score: scores[k], note: (categories[k].note ? categories[k].note + ";" : "") + "capped" };
    }
  }

  const missingFeatures = computeMissingFeatures(sig, categories);
  // The total is rescaled to 0-100 over the applicable categories only, so an
  // N/A category neither inflates nor deflates the score. applicableCount is
  // exposed so the report can show "N of 10 categories applicable".
  const applicableCount = applicableKeys.length;
  const applicableSum = applicableKeys.reduce((n, k) => n + categories[k].score, 0);
  let completenessScore =
    applicableCount === 0 ? 0 : Math.round((applicableSum / (applicableCount * 10)) * 100);
  if (totalCap !== null) completenessScore = Math.min(completenessScore, totalCap);
  const importMap = sig.files.map((f) => ({ path: f.path, imports: f.imports.slice(0, 40) }));

  return { categories, missingFeatures, completenessScore, applicableCount, capsApplied, importMap };
}

// ---------------------------------------------------------------------------
// Prompt rendering: the ground-truth block the LLM must reproduce exactly.
// ---------------------------------------------------------------------------

export function formatAssessmentForPrompt(a: DeterministicAssessment): string {
  const lines: string[] = [];
  lines.push("DETERMINISTIC GROUND TRUTH (computed from scan evidence — FINAL, reproduce exactly):");
  lines.push(`Total completeness score: ${a.completenessScore}/100 (rescaled over ${a.applicableCount} applicable of the 10 categories).`);
  lines.push(a.capsApplied.length > 0 ? `Caps applied: ${a.capsApplied.join("; ")}` : "Caps applied: none.");
  lines.push("");
  lines.push("Category scores (copy each score EXACTLY; write the reason from the evidence):");
  for (const k of CATEGORY_KEYS) {
    const c = a.categories[k];
    if (c.applicable === false) {
      lines.push(`- ${k}: N/A (not applicable — ${c.evidence.join(" | ")}; write score 0 and state "not applicable" in the reason; the server replaces it with the N/A marker)`);
    } else {
      lines.push(`- ${k}: ${c.score}/10 — evidence: ${c.evidence.join(" | ")}`);
    }
  }
  lines.push("");
  lines.push("Missing features (reproduce EXACTLY — same feature and category strings, same order; do not add, remove, or reword):");
  a.missingFeatures.forEach((m, i) => {
    lines.push(`${i + 1}. [${m.category}] ${m.feature} — evidence: ${m.evidence.join(" | ")}`);
  });
  if (a.missingFeatures.length === 0) lines.push("(none — every referenced capability is implemented)");
  lines.push("");
  lines.push("Import map (deterministic \u2014 reproduce each file's import list EXACTLY in applicationMap.components[].imports; never add or drop entries):");
  for (const e of a.importMap) {
    lines.push("- " + e.path + ": " + (e.imports.length > 0 ? e.imports.join(" | ") : "(no imports)"));
  }
  return lines.join("\n");
}

// Fallback reason when the model drops a category reason: built from evidence.
export function fallbackReason(key: CategoryKey, a: DeterministicAssessment): string {
  const c = a.categories[key];
  if (c.applicable === false) {
    return `Not applicable to this project (excluded from the total). Evidence: ${c.evidence.join("; ")}.`;
  }
  return `Deterministic score ${c.score}/10. Evidence: ${c.evidence.join("; ")}.`;
}

export function fallbackMissingReason(m: MissingFeatureFact): string {
  return `Detected by deterministic scan. Evidence: ${m.evidence.join("; ")}.`;
}
