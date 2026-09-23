// src/lib/probes/python.js
//
// Python security probe.
//
// Python was scanned but barely examined. Four v0.5 adapters covered unsafe
// deserialization, hardcoded keys, raw SQL and disabled TLS verification, and
// nothing else, so a realistic 41-line Flask app carrying SQL injection,
// `os.system` command injection, `send_file` path traversal, md5 password
// hashing, a plaintext password comparison, a hardcoded secret key, `eval` on
// request data and `debug=True` returned ZERO findings of any severity.
//
// A clean report on code like that is worse than no report. It is the one
// output a scanner must never produce, because the reader stops looking.
//
// Written after an adversarial pass measured the gap rather than assuming
// coverage from the presence of a language adapter directory (2026-07-27).
//
// Scope note: these are line-and-context regex checks, deliberately. The taint
// engine is JS/TS-only (it parses with acorn), so Python gets no dataflow. That
// means the shapes here are the direct ones — the request value visible at the
// call, or one line above it. Multi-hop Python flows remain uncovered and that
// is a known limit, not an oversight.

import { isTestFile, isScannerSelfSource } from '../file-filter.js';
import { maskCommentsForPath } from './_internal/masking.js';

// Request-derived values across the frameworks people actually use: Flask /
// Quart (`request.args|form|json|values|data|files|cookies|headers`), Django
// (`request.GET|POST|FILES|body|META`), FastAPI/Starlette (`request.query_params`),
// Tornado (`self.get_argument`), and the bare `req`/`event` shapes.
const PY_USER_INPUT =
  /\b(?:request|req)\s*\.\s*(?:args|form|json|values|data|files|cookies|headers|GET|POST|FILES|body|META|query_params|path_params)\b|\bself\s*\.\s*get_(?:argument|body_argument|query_argument)\s*\(|\bevent\s*\[\s*['"](?:body|queryStringParameters)['"]/;

// Interpolation shapes that put a value INTO a string: f-string, %-format,
// .format(), or `+` concatenation.
const PY_INTERPOLATED = /f['"]|%\s*\(|%\s*[a-zA-Z_(]|\.\s*format\s*\(|\+/;

// Path assembly that uses no string operator at all.
//
// `os.path.join(BASE, request.args.get("name"))` and `Path("uploads") / name`
// are how Python actually builds paths — more common than concatenation — and
// the interpolation test above sees neither, because there is no f-string, no
// %, no .format and no +. So the single most idiomatic traversal shape in the
// language was silent. Found 2026-07-27 by a hand-written positive control in
// the fix-PR corpus work, which is exactly what controls are for: the
// harvested pairs proved nothing, and the control caught a live gap.
//
// os.path.join is the sharper of the two. It does not merely fail to protect:
// given a second argument that starts with `/`, it DISCARDS the first, so
// os.path.join("uploads", "/etc/passwd") is "/etc/passwd".
const PY_PATH_ASSEMBLY = /os\s*\.\s*path\s*\.\s*join\s*\(|\bPath\s*\([^)]*\)\s*\/|\bPurePath\s*\(/;

// Evidence that the author resolved the path and then checked where it landed.
// `is_relative_to` after `.resolve()` is the documented containment test and is
// the fix this probe recommends; flagging it would be advising a change and
// then reporting the change.
const PY_PATH_CONTAINED =
  /\.\s*is_relative_to\s*\(|os\s*\.\s*path\s*\.\s*commonpath\s*\(|\.\s*startswith\s*\(\s*[A-Za-z_]|\bsecure_filename\s*\(|\bwerkzeug\b[\s\S]{0,40}secure_filename/;

const CMD_SINKS =
  /\bos\s*\.\s*(?:system|popen|startfile)\s*\(|\bsubprocess\s*\.\s*(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)\s*\(|\bcommands\s*\.\s*getoutput\s*\(/;
// `Path` is matched bare as well as via `pathlib.`, because `from pathlib
// import Path` is how everybody imports it, and the pathlib read/write methods
// are sinks in their own right: `(Path(base) / name).read_text()` never touches
// `open`, so a sink list built around `open` did not see it.
const FS_SINKS =
  /\bopen\s*\(|\bsend_file\s*\(|\bsend_from_directory\s*\(|\bos\s*\.\s*remove\s*\(|\bos\s*\.\s*unlink\s*\(|\bshutil\s*\.\s*(?:copy|move|rmtree)\s*\(|\b(?:pathlib\s*\.\s*)?Path\s*\(|\bos\s*\.\s*path\s*\.\s*join\s*\(|\.\s*(?:read_text|read_bytes|write_text|write_bytes|unlink)\s*\(/;
const HTTP_SINKS =
  /\brequests\s*\.\s*(?:get|post|put|patch|delete|head|options|request)\s*\(|\bhttpx\s*\.\s*(?:get|post|put|patch|delete|head|request|AsyncClient)\s*\(|\burllib\s*\.\s*request\s*\.\s*urlopen\s*\(|\burlopen\s*\(|\baiohttp\b[\s\S]{0,40}?\.\s*(?:get|post)\s*\(/;
const CODE_EXEC_SINKS = /(?<![.\w])(?:eval|exec)\s*\(|\bcompile\s*\(/;

// Password-ish identifiers, for the hashing and comparison checks.
const PW_NAME = /\b\w*(?:password|passwd|passphrase|pwd)\w*\b/i;

const finding = (o) => ({
  probe: 'Python Security',
  category: o.category || 'Injection',
  ...o,
});

export function probePythonSecurity(files) {
  const findings = [];
  files.forEach((file) => {
    if (isTestFile(file.path) || isScannerSelfSource(file.path)) return;
    if (!/\.py$/i.test(file.path)) return;

    // `#` comments blanked, string and docstring contents preserved: every
    // check below asks about a value that lives inside a string.
    const code = maskCommentsForPath(file.path, file.content);
    const lines = code.split('\n');
    const rawLines = file.content.split('\n');
    // Names bound to a request value on an earlier line, so the one-hop shape
    // everybody writes is visible:
    //     host = request.args.get("host")
    //     os.system("ping -c1 " + host)
    const tainted = new Set();
    lines.forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.+)$/);
      if (m && PY_USER_INPUT.test(m[2])) tainted.add(m[1]);
    });
    const taintedRe = tainted.size
      ? new RegExp(`\\b(?:${[...tainted].join('|')})\\b`)
      : /(?!)/; /* never matches */
    const carriesUserInput = (s) => PY_USER_INPUT.test(s) || taintedRe.test(s);

    const push = (o) => findings.push(finding({ ...o, file: file.path }));

    lines.forEach((line, i) => {
      const evidence = (rawLines[i] ?? line).trim().slice(0, 200);
      const ln = i + 1;

      // --- Command injection.
      if (CMD_SINKS.test(line)) {
        const shellTrue = /shell\s*=\s*True/.test(line);
        const interpolated = PY_INTERPOLATED.test(line);
        if (carriesUserInput(line) && interpolated) {
          push({
            id: `py-cmdi-${file.path}-${ln}`,
            title: 'Shell command built from request data',
            severity: 'critical',
            cwe: 'CWE-78',
            line: ln,
            evidence,
            remediation:
              'The caller chooses part of the command line, so they choose the command: `; rm -rf /` or a backtick substitution ends your argument and starts theirs. Pass a LIST and no shell — subprocess.run(["ping", "-c1", host], shell=False) — so the value can only ever be one argument. If a shell is genuinely required, shlex.quote() the value, and validate it against an allowlist first.',
          });
        } else if (shellTrue && interpolated) {
          push({
            id: `py-shelltrue-${file.path}-${ln}`,
            title: 'Shell command assembled with shell=True',
            severity: 'high',
            cwe: 'CWE-78',
            line: ln,
            evidence,
            remediation:
              'shell=True hands the whole string to /bin/sh, so every shell metacharacter in it is live. Pass the command as a list with shell=False. The value here is built by interpolation, which is one refactor away from carrying user input even if it does not today.',
          });
        }
      }

      // --- Path traversal.
      //
      // Assembly is either a string operator or a path-joining call. The
      // containment window looks at the surrounding lines rather than this one,
      // because `resolve()` and the `is_relative_to` check that makes it safe
      // are two statements by construction.
      const contained = PY_PATH_CONTAINED.test(lines.slice(Math.max(0, i - 4), i + 6).join('\n'));
      if (
        FS_SINKS.test(line) &&
        carriesUserInput(line) &&
        (PY_INTERPOLATED.test(line) || PY_PATH_ASSEMBLY.test(line)) &&
        !contained
      ) {
        push({
          id: `py-path-${file.path}-${ln}`,
          title: 'Filesystem path built from request data',
          severity: 'high',
          cwe: 'CWE-22',
          line: ln,
          evidence,
          remediation:
            '`../../etc/passwd` walks straight out of the directory you meant. Resolve against a fixed base and confirm the result is still inside it: base = Path("uploads").resolve(); target = (base / name).resolve(); then reject unless target.is_relative_to(base). os.path.join does NOT protect you — an absolute path in the second argument discards the first.',
        });
      }

      // --- SSRF.
      if (HTTP_SINKS.test(line) && carriesUserInput(line)) {
        push({
          id: `py-ssrf-${file.path}-${ln}`,
          title: 'Outbound request to a URL from request data',
          severity: 'high',
          cwe: 'CWE-918',
          line: ln,
          evidence,
          remediation:
            'The caller chooses what your server connects to, which includes 169.254.169.254 for cloud instance credentials and anything else inside your network. Resolve the host against an allowlist before the call, reject non-http(s) schemes, and block link-local and private ranges after DNS resolution rather than before.',
        });
      }

      // --- eval / exec on request data.
      if (CODE_EXEC_SINKS.test(line) && carriesUserInput(line)) {
        push({
          id: `py-eval-${file.path}-${ln}`,
          title: 'eval/exec on request data',
          severity: 'critical',
          cwe: 'CWE-95',
          line: ln,
          evidence,
          remediation:
            'This is remote code execution, not a sanitisation problem: eval() runs whatever arrives. For arithmetic use ast.literal_eval, which evaluates literals only. For anything richer, parse the input into a structure you defined and dispatch on it.',
        });
      }

      // --- Weak password hashing.
      if (/\bhashlib\s*\.\s*(?:md5|sha1)\s*\(/.test(line)) {
        const ctx = lines.slice(Math.max(0, i - 3), i + 2).join(' ');
        if (PW_NAME.test(ctx)) {
          push({
            id: `py-weakhash-${file.path}-${ln}`,
            title: 'Password hashed with md5/sha1',
            severity: 'critical',
            category: 'Cryptographic Failure',
            cwe: 'CWE-916',
            line: ln,
            evidence,
            remediation:
              'md5 and sha1 are fast, which is the entire problem: commodity hardware tries billions of candidates a second against a stolen table. Use a deliberately slow, salted password hash — bcrypt (`bcrypt.hashpw`), argon2 (`argon2.PasswordHasher`), or `hashlib.scrypt`. Rehash on next successful login rather than forcing a reset.',
          });
        }
      }

      // --- Plaintext password comparison.
      if (
        /==/.test(line) &&
        PW_NAME.test(line) &&
        !/\b(?:check_password|verify|compare_digest|checkpw)\s*\(/.test(line) &&
        !/\b(?:test|dummy|mock|sample|expected|fake|placeholder)_?(?:password|passwd|pwd)\b/i.test(
          line
        )
      ) {
        push({
          id: `py-plainpw-${file.path}-${ln}`,
          title: 'Plaintext password comparison',
          severity: 'critical',
          category: 'Auth & Access',
          cwe: 'CWE-261',
          line: ln,
          evidence,
          remediation:
            'Comparing a password with == means the stored value is the password, so anyone who reads the database has every account. Store a hash and verify with the library that made it: bcrypt.checkpw(entered, stored) or argon2 PasswordHasher.verify. Those are also constant-time, which == is not.',
        });
      }

      // --- Credential assigned a literal. The v0.5 secrets adapter matches
      // provider-shaped keys (sk_live_, AKIA…); a bare `ADMIN_PASSWORD = "…"`
      // or `app.secret_key = "…"` is a different shape and was uncovered.
      {
        const m = line.match(
          /^\s*(?:[\w.]*\.)?(\w*(?:password|passwd|pwd|secret|secret_key|api_key|apikey|token|access_key)\w*)\s*=\s*(['"])([^'"\n]{6,})\2/i
        );
        // A value read from the environment or a config object is the fix, not
        // the finding. Placeholders are documentation.
        const PLACEHOLDER =
          /^(?:x{3,}|\.{3,}|<[^>]+>|\{\{.*\}\}|your[-_ ]|change[-_ ]?me|replace[-_ ]?me|placeholder|example|dummy|test|sample|todo|none|null|password|secret|123456)/i;
        if (m && !PLACEHOLDER.test(m[3]) && !/^\s*#/.test(line)) {
          push({
            id: `py-hardcoded-${file.path}-${ln}`,
            title: `Hardcoded credential in "${m[1]}"`,
            severity: 'critical',
            category: 'Auth & Access',
            cwe: 'CWE-798',
            line: ln,
            evidence,
            remediation:
              'A credential in source is a credential in every clone, every fork, and the whole git history — deleting the line does not remove it from the repository. Read it from the environment (os.environ["ADMIN_PASSWORD"]) or a secret manager, and rotate this value now, because it should be treated as public from the moment it was committed.',
          });
        }
      }

      // --- Flask/Django debug mode.
      if (
        /\.run\s*\([^)]*debug\s*=\s*True/.test(line) ||
        /^\s*DEBUG\s*=\s*True\s*$/.test(line.trimEnd())
      ) {
        push({
          id: `py-debug-${file.path}-${ln}`,
          title: 'Debug mode enabled',
          severity: 'high',
          category: 'Misconfiguration',
          cwe: 'CWE-489',
          line: ln,
          evidence,
          remediation:
            "Flask's debug mode serves the Werkzeug console on an unhandled exception, and that console executes Python. Django's DEBUG=True renders settings and query history into error pages. Read the flag from the environment and default it to off, so shipping it enabled takes a deliberate act.",
        });
      }
    });
  });
  return findings;
}
