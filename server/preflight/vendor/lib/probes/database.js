// src/lib/probes/database.js
//
// Database-rules probes: Supabase RLS, Firebase Rules.
//
// Extracted from the prior builtin.js monolith when it crossed the
// file-size HIGH threshold. Probe bodies are byte-identical to the
// originals; only the location moved. Public import surface is
// preserved by builtin.js, which is now a back-compat shim re-exporting
// every probe function from its new family file.

import { isTestFile } from '../file-filter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Client-side reads of tables this repo never protects
// ─────────────────────────────────────────────────────────────────────────────
//
// The migration checks below only run on `.sql` files, which means they say
// nothing at all about the population that actually gets breached. The
// CVE-2025-48757 disclosure found 170 of 1,645 Lovable showcase apps (10.3%)
// leaking PII through unprotected tables, and those apps typically have no
// migration files in the repo whatsoever: the schema was created by clicking
// around a dashboard. A scanner named "Supabase RLS" that returns zero on
// exactly those repos is not neutral, it is reassuring, which is worse.
//
// So the second phase reads the other direction. Find the tables this code
// queries with the browser client, subtract the tables some migration in this
// repo provably protects, and report the difference.
//
// What this cannot know is whether RLS was switched on in the dashboard, and
// the finding says so rather than pretending. That uncertainty is why these
// land at high rather than critical: a missing ENABLE in a migration you can
// read is a fact, while an unprotected-looking table might be fine. The
// remediation leads with the ten-second way to check.

// `@supabase/supabase-js` is the classic entry point, but a current Next.js App
// Router project depends on `@supabase/ssr` (or the older auth-helpers) and may
// never name supabase-js directly. Matching only the first would have missed
// the newest half of the ecosystem, which is also the half most likely to have
// been generated rather than written.
const SUPABASE_PACKAGE_RE = /@supabase\/(?:supabase-js|ssr|auth-helpers[\w-]*)/;
// Every factory those packages expose.
const SUPABASE_FACTORY_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:createClient|createBrowserClient|createServerClient|createPagesBrowserClient|createPagesServerClient|createClientComponentClient|createServerComponentClient|createRouteHandlerClient|createMiddlewareClient)\s*\(/g;
// Names a Supabase handle actually goes by. Deliberately a short list: `.from()`
// is also Knex, Objection and several query builders, and the package check
// above plus a recognisable receiver is what keeps this off them.
const SUPABASE_HANDLE_RE = /^(?:supabase|supabaseClient|supabaseAdmin|supabaseServer|supa|sb)$/i;

function collectSupabaseHandles(files) {
  const handles = new Set();
  let isSupabaseProject = false;
  for (const file of files || []) {
    const content = file?.content || '';
    const path = file?.path || '';
    if (/package\.json$/i.test(path) && SUPABASE_PACKAGE_RE.test(content)) isSupabaseProject = true;
    if (!/\.[jt]sx?$/i.test(path)) continue;
    if (SUPABASE_PACKAGE_RE.test(content)) isSupabaseProject = true;
    // const supabase = createClient(url, key) / createBrowserClient() / …
    for (const m of content.matchAll(SUPABASE_FACTORY_RE)) handles.add(m[1]);
    // import { supabase } from '../lib/supabase'
    for (const m of content.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*supabase[^'"]*['"]/gi
    ))
      for (const part of m[1].split(','))
        handles.add(
          part
            .split(/\s+as\s+/i)
            .pop()
            .trim()
        );
  }
  return { handles, isSupabaseProject };
}

function collectProtectedTables(files) {
  const protectedTables = new Set();
  let sawMigration = false;
  for (const file of files || []) {
    if (!/\.sql$/i.test(file?.path || '')) continue;
    sawMigration = true;
    for (const m of (file.content || '').matchAll(
      /alter\s+table\s+(?:[a-z_][\w]*\.)?["`]?([A-Za-z_][\w]*)["`]?\s+enable\s+row\s+level\s+security/gi
    ))
      protectedTables.add(m[1].toLowerCase());
  }
  return { protectedTables, sawMigration };
}

function probeSupabaseClientReads(files) {
  const findings = [];
  const { handles, isSupabaseProject } = collectSupabaseHandles(files);
  if (!isSupabaseProject) return findings;
  const { protectedTables, sawMigration } = collectProtectedTables(files);
  // One finding per table, not per call site. A table read in twenty places is
  // one unprotected table, and twenty findings would be the same noise this
  // codebase has spent the week removing.
  const reported = new Set();

  for (const file of files || []) {
    const path = file?.path || '';
    const content = file?.content || '';
    if (!/\.[jt]sx?$/i.test(path) || isTestFile(path)) continue;
    // `\s` already spans newlines, which is what matters here: prettier breaks
    // a Supabase chain onto its own lines the moment it gets long, and the
    // long ones are the interesting ones.
    //
    //   const { data } = await supabase
    //     .from('profiles')
    //     .select('*')
    for (const m of content.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*\.\s*from\s*\(\s*['"]([A-Za-z_][\w]*)['"]\s*\)\s*\.\s*(select|insert|update|upsert|delete)\s*\(/g
    )) {
      const [, receiver, table, op] = m;
      if (!handles.has(receiver) && !SUPABASE_HANDLE_RE.test(receiver)) continue;
      if (protectedTables.has(table.toLowerCase())) continue;
      if (reported.has(table.toLowerCase())) continue;
      reported.add(table.toLowerCase());
      findings.push({
        id: `rls-client-unprotected-${table.toLowerCase()}`,
        probe: 'Supabase RLS Check',
        title: `Table "${table}" is queried from the client and nothing in this repo enables RLS on it`,
        severity: 'high',
        category: 'Data Breach',
        cwe: 'CWE-284',
        file: path,
        line: content.slice(0, m.index).split('\n').length,
        evidence: m[0].replace(/\s+/g, ' ').slice(0, 120),
        remediation: [
          op === 'select'
            ? `Open the Supabase dashboard, go to Authentication then Policies, and look at "${table}". If Row Level Security is off, every row in that table is readable by anyone who opens devtools and copies the anon key out of your JavaScript bundle. The anon key is public by design, so it is not a secret you can protect.`
            : `Open the Supabase dashboard, go to Authentication then Policies, and look at "${table}". This code reaches the table with .${op}(), so if Row Level Security is off, anyone holding the anon key can write to it as well as read it. The anon key is public by design: it ships in your JavaScript bundle and cannot be kept secret.`,
          sawMigration
            ? `This repo has migrations, and none of them run ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY.`
            : `This repo has no .sql migrations, so the schema was most likely created through the dashboard and RLS was never part of a reviewed file.`,
          `The fix is two statements:\n\n  ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;\n  CREATE POLICY "${table}_own_rows" ON public.${table}\n    FOR SELECT USING (auth.uid() = user_id);`,
          `One thing worth internalising: filtering in the query, for example .eq('user_id', user.id), is not what protects this. That filter runs on the client and an attacker simply does not send it. RLS is the only part of this the user cannot edit.`,
        ].join('\n\n'),
      });
    }
  }
  return findings;
}

export function probeSupabaseRLS(files) {
  const findings = probeSupabaseClientReads(files);
  files.forEach((file) => {
    if (!/\.sql$/.test(file.path)) return;
    const content = file.content;
    // Allow case-insensitive identifier capture (Supabase + Postgres allow "Users" etc).
    const tableMatches = [
      ...content.matchAll(
        /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:[a-z_][\w]*\.)?["`]?([A-Za-z_][\w]*)["`]?/gi
      ),
    ];
    tableMatches.forEach((tm) => {
      const tableName = tm[1];
      // Match the same table regardless of schema qualifier (public.users, app.users, plain users).
      const enableRegex = new RegExp(
        `alter\\s+table\\s+(?:[a-z_][\\w]*\\.)?["\`]?${tableName}["\`]?\\s+enable\\s+row\\s+level\\s+security`,
        'i'
      );
      if (!enableRegex.test(content)) {
        findings.push({
          id: `rls-${file.path}-${tableName}`,
          probe: 'Supabase RLS Check',
          title: `Table "${tableName}" missing ENABLE ROW LEVEL SECURITY`,
          severity: 'critical',
          category: 'Data Breach',
          cwe: 'CWE-284',
          file: file.path,
          line: tm.index ? content.slice(0, tm.index).split('\n').length : 1,
          evidence: tm[0],
          remediation: `Add the following to your migration:\n\nALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY;\n\nThen create explicit policies for SELECT, INSERT, UPDATE, DELETE. Without RLS, any client with the anon key can read and modify all rows. This is the single most common Supabase production breach.`,
        });
      }
    });
    const permissivePolicies = [
      ...content.matchAll(/create\s+policy[\s\S]*?using\s*\(\s*true\s*\)/gi),
    ];
    permissivePolicies.forEach((pm) => {
      findings.push({
        id: `rls-permissive-${file.path}-${pm.index}`,
        probe: 'Supabase RLS Check',
        title: 'Permissive RLS policy "USING (true)"',
        severity: 'high',
        category: 'Data Breach',
        cwe: 'CWE-284',
        file: file.path,
        line: content.slice(0, pm.index).split('\n').length,
        evidence: pm[0].slice(0, 200).replace(/\s+/g, ' '),
        remediation: `A USING (true) policy allows the policy role to access every row. Replace with an explicit predicate, e.g. USING (auth.uid() = user_id) for owner-only access, or scope to specific roles.`,
      });
    });
    // Depth round 3: WITH CHECK (true) is the insert/update analog of USING(true).
    [...content.matchAll(/create\s+policy[\s\S]*?with\s+check\s*\(\s*true\s*\)/gi)].forEach(
      (pm) => {
        findings.push({
          id: `rls-permissive-check-${file.path}-${pm.index}`,
          probe: 'Supabase RLS Check',
          title: 'Permissive RLS policy "WITH CHECK (true)"',
          severity: 'high',
          category: 'Data Breach',
          cwe: 'CWE-284',
          file: file.path,
          line: content.slice(0, pm.index).split('\n').length,
          evidence: pm[0].slice(0, 200).replace(/\s+/g, ' '),
          remediation:
            'WITH CHECK (true) lets the policy role insert or update any row. Replace with the same ownership predicate you use for USING, e.g. WITH CHECK (auth.uid() = user_id).',
        });
      }
    );
    // Depth round 3: explicit DISABLE ROW LEVEL SECURITY is a critical
    // regression — the table was protected, now it isn't.
    [
      ...content.matchAll(
        /alter\s+table\s+(?:[a-z_][\w]*\.)?["`]?([A-Za-z_][\w]*)["`]?\s+disable\s+row\s+level\s+security/gi
      ),
    ].forEach((dm) => {
      findings.push({
        id: `rls-disabled-${file.path}-${dm.index}`,
        probe: 'Supabase RLS Check',
        title: `Row Level Security explicitly DISABLED on "${dm[1]}"`,
        severity: 'critical',
        category: 'Data Breach',
        cwe: 'CWE-284',
        file: file.path,
        line: content.slice(0, dm.index).split('\n').length,
        evidence: dm[0],
        remediation:
          'DISABLE ROW LEVEL SECURITY removes all per-row authorization. Any client with anon key access can read or modify every row. Re-enable with ALTER TABLE ... ENABLE ROW LEVEL SECURITY and define policies; if you intentionally need owner-bypass, scope it to specific roles via FORCE ROW LEVEL SECURITY semantics.',
      });
    });
    // SECURITY DEFINER function referenced inside USING() of a policy bypasses
    // the caller's RLS — runs with creator's permissions. Canonical RLS escape.
    const definerFns = [
      ...content.matchAll(
        /create\s+(?:or\s+replace\s+)?function\s+([a-zA-Z_]\w*)[\s\S]*?security\s+definer/gi
      ),
    ].map((m) => m[1]);
    if (definerFns.length) {
      const policyUsingFns = [
        ...content.matchAll(/create\s+policy[\s\S]*?using\s*\(\s*([a-zA-Z_]\w*)\s*\(/gi),
      ];
      policyUsingFns.forEach((pm) => {
        if (definerFns.includes(pm[1])) {
          findings.push({
            id: `rls-securitydefiner-${file.path}-${pm.index}`,
            probe: 'Supabase RLS Check',
            title: `Policy uses SECURITY DEFINER function ${pm[1]}() (bypasses caller's RLS)`,
            severity: 'high',
            category: 'Data Breach',
            cwe: 'CWE-274',
            file: file.path,
            line: content.slice(0, pm.index).split('\n').length,
            evidence: pm[0].slice(0, 200).replace(/\s+/g, ' '),
            remediation: `${pm[1]}() is declared SECURITY DEFINER, so it runs with the function-creator's privileges (usually postgres) rather than the caller's. When called from a policy, it can read data the caller wasn't authorized to see, defeating RLS. Switch the function to SECURITY INVOKER, or inline the check.`,
          });
        }
      });
    }
  });
  return findings;
}

export function probeFirebaseRules(files) {
  const findings = [];
  files.forEach((file) => {
    // Depth round 3: added Realtime Database rules (database.rules.json /
    // database.rules / *.rules.bolt). RTDB uses a JSON tree of .read/.write
    // string expressions; check for the literal "true" or "auth != null".
    if (/(?:^|\/)database\.rules\.json$/.test(file.path)) {
      let parsed;
      try {
        parsed = JSON.parse(file.content);
      } catch {
        return;
      }
      const walk = (node, path, line) => {
        if (!node || typeof node !== 'object') return;
        for (const [key, val] of Object.entries(node)) {
          if (key === '.read' || key === '.write') {
            const expr = String(val).trim();
            if (expr === 'true') {
              findings.push({
                id: `firebase-rtdb-true-${file.path}-${path}-${key}`,
                probe: 'Firebase Rules Check',
                title: `Realtime DB rule ${key} grants unrestricted access at ${path || '/'}`,
                severity: 'critical',
                category: 'Data Breach',
                cwe: 'CWE-284',
                file: file.path,
                line: 1,
                evidence: `"${path || '/'}": { "${key}": "true" }`,
                remediation: `"true" in a Realtime DB .read/.write rule lets anyone on the internet read or write this path. Replace with an auth + ownership expression, e.g. ".read": "auth != null && data.child('owner').val() === auth.uid".`,
              });
            } else if (expr === 'auth != null' || expr === 'auth.uid != null') {
              findings.push({
                id: `firebase-rtdb-authonly-${file.path}-${path}-${key}`,
                probe: 'Firebase Rules Check',
                title: `Realtime DB rule ${key} allows any authenticated user at ${path || '/'}`,
                severity: 'high',
                category: 'Data Breach',
                cwe: 'CWE-284',
                file: file.path,
                line: 1,
                evidence: `"${path || '/'}": { "${key}": "${expr}" }`,
                remediation:
                  'Any logged-in user can read or write this node, including reading other users data. Add an ownership check: "auth.uid === $uid" with a "$uid" wildcard segment.',
              });
            }
          } else if (typeof val === 'object') {
            walk(val, path + '/' + key, line);
          }
        }
      };
      if (parsed && parsed.rules) walk(parsed.rules, '', 1);
      return;
    }
    if (!/firestore\.rules$|storage\.rules$|\.rules\.bolt$/.test(file.path)) return;
    const content = file.content;
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (/allow\s+(read|write|create|update|delete|get|list)[^;]*:\s*if\s+true\s*;/.test(line)) {
        findings.push({
          id: `firebase-true-${file.path}-${i}`,
          probe: 'Firebase Rules Check',
          title: 'Firebase rule grants unrestricted access',
          severity: 'critical',
          category: 'Data Breach',
          cwe: 'CWE-284',
          file: file.path,
          line: i + 1,
          evidence: line.trim(),
          remediation: `"if true" allows anyone on the internet to read or write. Replace with an authentication check at minimum (request.auth != null) and an ownership check ideally (request.auth.uid == resource.data.userId). Test rules in the Firebase emulator before deploying.`,
        });
      }
      // Depth round 3: drop the storage-rules-only gate. Firestore rules with
      // `allow X: if request.auth != null` is THE canonical leak shape and
      // the Learn pattern names it explicitly. Also accept the
      // `request.auth.uid != null` semantic dup and `auth.uid IS NOT NULL`
      // SQL-ish variants.
      if (
        /allow\s+(?:read|write|create|update|delete|get|list)[^;]*:\s*if\s+request\.auth(?:\.uid)?\s*(?:!=|<>)\s*null\s*;/.test(
          line
        )
      ) {
        const isStorage = /storage\.rules$/.test(file.path);
        findings.push({
          id: `firebase-auth-only-${file.path}-${i}`,
          probe: 'Firebase Rules Check',
          title: isStorage
            ? 'Storage rule allows any authenticated user'
            : 'Firestore rule allows any authenticated user',
          severity: 'high',
          category: 'Data Breach',
          cwe: 'CWE-284',
          file: file.path,
          line: i + 1,
          evidence: line.trim(),
          remediation: isStorage
            ? `Any authenticated user can read or write this path, including users accessing each other's files. Add an ownership check, e.g. allow read: if request.auth.uid == resource.metadata.ownerId;`
            : `Any authenticated user can read or write this document, including reading other users data. Add ownership: allow read: if request.auth.uid == resource.data.owner; and writes that verify request.resource.data.owner == request.auth.uid.`,
        });
      }
      // Recursive wildcard + auth-only is the canonical "any logged-in user
      // reads everything" shape (per the Learn pattern).
      if (
        /match\s+\/\{[a-zA-Z_]+=\*\*\}\s*\{[^}]*allow\s+(?:read|write)[^;]*:\s*if\s+request\.auth\s*!=\s*null/.test(
          content
        ) &&
        line.includes('{document=**}')
      ) {
        findings.push({
          id: `firebase-recursive-wildcard-${file.path}-${i}`,
          probe: 'Firebase Rules Check',
          title: 'Recursive wildcard match grants auth-only access to all documents',
          severity: 'critical',
          category: 'Data Breach',
          cwe: 'CWE-284',
          file: file.path,
          line: i + 1,
          evidence: line.trim(),
          remediation:
            'A recursive wildcard `match /{document=**}` with `if request.auth != null` lets any logged-in user read every document in your database. Scope rules to specific collections with ownership predicates.',
        });
      }
      // Explicit disable of the implicit deny.
      if (/allow\s+(?:read|write|create|update|delete)[^;]*:\s*if\s+false\s*;/.test(line)) {
        // Explicit deny is intentional — no finding. Documented as the
        // recommended kill-switch.
      }
    });
  });
  return findings;
}
