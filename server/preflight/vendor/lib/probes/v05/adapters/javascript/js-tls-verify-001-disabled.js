// src/lib/probes/v05/adapters/javascript/js-tls-verify-001-disabled.js
//
// XL-004 adapter for JavaScript / TypeScript. RX-based.
//
// Fourteen languages carried a TLS-verification adapter and JavaScript was not
// one of them, so `new https.Agent({ rejectUnauthorized: false })` was silent
// in the language most of the scanned corpus is written in while the Python
// equivalent (`verify=False`) fired at high severity. Same family, same CWE,
// same fix; only the flag name differs.
//
// Catches the three shapes Node code uses to turn certificate checking off:
// the per-agent option, the process-wide environment override, and the legacy
// `strictSSL: false` from the request / npm client family.

import { javascriptFiles } from '../../shared-detectors/javascript-scope.js';
import { maskCodeShapeForPath, maskCommentsForPath } from '../../../_internal/masking.js';
import { lineIsProseString } from '../../../_internal/prose.js';

const PROBE_NAME = 'JavaScript TLS Verification Disabled';

// https.Agent, tls.connect, ws, axios httpsAgent, node-fetch agent: all of
// them spell it the same way, and `rejectUnauthorized` is a TLS-only option
// name in Node, so the identifier alone is unambiguous.
const REJECT_UNAUTHORIZED_FALSE_RE = /\brejectUnauthorized\s*:\s*false\b/;

// process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' and its bracket-access and
// config-object spellings. Only the value 0 disables verification; '1' is the
// default and is not a finding.
const NODE_TLS_ENV_OFF_RE = /\bNODE_TLS_REJECT_UNAUTHORIZED\b['"\]\s]*[=:]\s*['"`]?\s*0\b/;

// request / npm / gulp-family clients.
const STRICT_SSL_FALSE_RE = /\bstrictSSL\s*:\s*false\b/;

export const JS_TLS_VERIFY_001 = {
  probe_id: 'JS-TLS-VERIFY-001',
  xl_family: 'XL-004',
  language: 'javascript',
  name: PROBE_NAME,
  category: 'transport',
  severity: 'high',
  confidence: 'high',
  cwe: 'CWE-295',
  owasp_web: 'A02',
  owasp_llm: null,
  detector: 'rx',
  scope: '**/*.{js,jsx,ts,tsx,mjs,cjs}',
  what_it_catches:
    'rejectUnauthorized: false on an https.Agent, tls.connect, axios httpsAgent or fetch agent; process.env.NODE_TLS_REJECT_UNAUTHORIZED set to 0; strictSSL: false. Each one accepts any certificate, so a network attacker can man-in-the-middle every HTTPS call the client makes.',
  why_ai_v05:
    'A self-signed cert or a corporate proxy makes the request throw UNABLE_TO_VERIFY_LEAF_SIGNATURE, and the answer that dominates the training corpus is rejectUnauthorized: false, not a CA bundle. The model learned from "fix my SSL error" threads.',
  vibe_v05: '"The request works with the cert check off, so the cert check was the problem."',
  detection_approach:
    'RX per line over the comment-blind view: rejectUnauthorized: false, NODE_TLS_REJECT_UNAUTHORIZED assigned 0, strictSSL: false.',
  fp_gates_v05: [
    'comments and string bodies (maskCodeShapeForPath), so prose quoting the pattern is not the pattern',
    'rejectUnauthorized: true and NODE_TLS_REJECT_UNAUTHORIZED set to 1',
    'a value read from a variable or the environment rather than the literal false',
    'test files / scanner self-source / v0.5 fixture tree (handled by javascriptFiles())',
  ],
  remediation:
    'Give the client the certificate authority instead of removing the check: new https.Agent({ ca: fs.readFileSync("corp-ca.pem") }), or set NODE_EXTRA_CA_CERTS to the bundle path so every client in the process trusts it. Never ship rejectUnauthorized: false.',
  autofix_v05: 'review-needed',
  fixtures_v05: {
    positive: 'src/lib/probes/v05/fixtures/JS-TLS-VERIFY-001/positive.js',
    negative: 'src/lib/probes/v05/fixtures/JS-TLS-VERIFY-001/negative.js',
  },
  known_incidents: 'CWE-295; OWASP A02; Node.js tls.connect and https.Agent docs',
  ioc_bundle_ref: null,
  maturity: 'experimental',
  shadow: false,
  legacy_finding_id_seed: null,
  detect(files) {
    const findings = [];
    for (const f of javascriptFiles(files)) {
      const raw = typeof f.content === 'string' ? f.content : '';
      if (!raw) continue;
      // Comment bodies blanked, string bodies preserved: the environment
      // override writes its value as the string '0', so the string contents
      // have to survive, and a comment describing the flag must not fire.
      // Strings blanked as well as comments. Every shape here is a CODE
      // shape: `rejectUnauthorized: false` is an object property, and
      // NODE_TLS_REJECT_UNAUTHORIZED is an assignment target. None of them can
      // legitimately live inside a quoted string, and the comment-blind view
      // is not enough — this adapter's own remediation copy quotes the
      // patterns it hunts, so it reported itself seven times on the first
      // scan after it landed. Same defect the masking work spent the day
      // removing, arriving in new code the same afternoon.
      const code = maskCodeShapeForPath(f.path, raw);
      const lines = code.split('\n');
      const rawLines = raw.split('\n');
      // The environment override cannot use the view above: its value is the
      // STRING '0', which that view blanks along with every other string body,
      // so the check would never see the 0 it needs. It reads the comment-blind
      // view instead and takes the prose guard. That is the same split the
      // masking work settled on: a check about code SHAPE reads the strict
      // view, a check about a string VALUE reads the permissive one and screens
      // out sentences.
      const valueLines = maskCommentsForPath(f.path, raw).split('\n');
      lines.forEach((line, i) => {
        const valueLine = valueLines[i] || '';
        const agentOff = REJECT_UNAUTHORIZED_FALSE_RE.test(line);
        // Anchor in code, value in the string view.
        //
        // The identifier has to survive the strings-blanked view, which proves
        // it is an assignment target rather than text; the `'0'` is then read
        // from the permissive view, which is the only place it exists. The
        // prose guard alone was not enough here: this adapter's own finding
        // TITLE names the variable, and a six-word technical title is not a
        // sentence by any grammar test, so it read as code and reported itself.
        // The anchor is `process.env`, not the variable name. Bracket access
        // (`process.env['NODE_TLS_REJECT_UNAUTHORIZED']`) puts the name inside
        // a string literal, where the strings-blanked view cannot see it, so
        // anchoring on the name lost a real shape. `process.env` survives in
        // both spellings and appears in no finding title.
        const envOff =
          /process\s*\.\s*env\b|\benv\s*\[/.test(line) &&
          NODE_TLS_ENV_OFF_RE.test(valueLine) &&
          !lineIsProseString(valueLine);
        const strictOff = STRICT_SSL_FALSE_RE.test(line);
        if (!agentOff && !envOff && !strictOff) return;
        findings.push({
          id: `js-tls-${f.path}-${i}`,
          probe: PROBE_NAME,
          title: envOff
            ? 'TLS certificate verification disabled process-wide (NODE_TLS_REJECT_UNAUTHORIZED=0)'
            : agentOff
              ? 'TLS certificate verification disabled (rejectUnauthorized: false)'
              : 'TLS certificate verification disabled (strictSSL: false)',
          // The environment override is not scoped to one client. It switches
          // verification off for every TLS connection the process opens,
          // including ones added later by a dependency.
          severity: envOff ? 'critical' : 'high',
          category: 'Transport',
          cwe: 'CWE-295',
          file: f.path,
          line: i + 1,
          evidence: (rawLines[i] ?? line).trim().slice(0, 200),
          remediation: envOff
            ? 'NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checking for every TLS client in the process, so a network attacker can present any certificate and read or rewrite the traffic. Point Node at the certificate authority instead: set NODE_EXTRA_CA_CERTS to the CA bundle path, or pass { ca: fs.readFileSync("corp-ca.pem") } to the specific client that needs it.'
            : 'Accepting any certificate means you encrypted the channel to whoever answered, which is what a network attacker wants. Supply the certificate authority instead: new https.Agent({ ca: fs.readFileSync("corp-ca.pem") }). If a self-signed cert is only needed on a developer machine, read the flag from an environment variable that production cannot set.',
        });
      });
    }
    return findings;
  },
};
