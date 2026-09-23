// src/lib/probes/crypto.js
//
// Weak cryptography probe (JavaScript / TypeScript).
//
// The registry had one crypto-primitive rule before this file, inside Auth
// Weakness, and it turned on the VARIABLE NAME rather than the construct: it
// only fires when the token `password|passwd|pwd|pw` appears inside the
// `.update(...)` argument. So this was reported:
//
//     crypto.createHash('md5').update(password).digest('hex')
//
// and this, the same bug written by anyone who names the parameter something
// else, was silent:
//
//     crypto.createHash('md5').update(p).digest('hex')
//
// Cipher construction had no coverage at all. None of these produced a finding:
//
//     crypto.createCipheriv('aes-256-ecb', key, null)      // ECB
//     crypto.createCipheriv('des-ede3', key, iv)           // 3DES
//     const IV = Buffer.from('0000000000000000', 'hex')    // fixed IV
//     crypto.createCipheriv('aes-256-cbc', key, IV)
//     crypto.createCipher('aes-256-cbc', passphrase)       // MD5 KDF, zero IV
//
// This module covers the construct. Scope is JS/TS only, because that is where
// the `crypto` module names below mean what they say; Python's weak-hash shape
// lives in probes/python.js.
//
// ---------------------------------------------------------------------------
// The precision half, which is most of the design.
//
// md5 and sha1 are not wrong. They are wrong FOR SOMETHING. A content digest,
// an ETag, a cache key, a file checksum, a dedupe fingerprint: md5 is the
// correct, conventional, fast choice and flagging it is how a scanner teaches
// people to skim past its own panel. So the hash checks require credential
// context and stay quiet otherwise.
//
// Same on the cipher side. `aes-256-gcm`, `aes-256-cbc` with a per-message
// random IV, and `crypto.randomBytes(16)` are the FIX this probe recommends.
// A probe that flags its own remediation is worse than no probe.
// ---------------------------------------------------------------------------

import { isTestFile, isScannerSelfSource } from '../file-filter.js';
import {
  maskCommentsForPath,
  maskCodeShapeForPath,
  isMatchInsideTemplateLiteral,
} from './_internal/masking.js';

const JS_TS_FILE_RE = /\.(?:m|c)?[jt]sx?$/i;

// Union of every token any check below needs. Deliberately loose: it runs on
// raw bytes as a skip test, so over-matching only costs a masking pass and
// under-matching would cost a finding.
// File-level fast gate, ahead of two masking passes. The raw view is a
// superset of both masked views, so a file with none of these tokens had
// nothing for any check to find and can be skipped whole. Worth ~25x on a
// 2,270-file corpus.
//
// scrypt and pbkdf2 joined the list when the KDF-parameter check landed: a
// module that derives a key and neither hashes nor enciphers matches none of
// the original tokens, so the probe returned before reaching the new check and
// `scryptSync(password, 'salt', 24)` on its own stayed silent. A gate is only
// correct while it is a superset of everything downstream of it, and adding a
// check without revisiting it is how that invariant quietly breaks.
const CRYPTO_TOKEN_RE =
  /createHash|createCipher|createDecipher|CryptoJS|forge|subtle|scrypt|pbkdf2/;

// Any cipher construction API. Used as a file-level gate for the algorithm
// string checks: a bare `'des'` or `'bf-cbc'` in a file that never builds a
// cipher is a word, not an algorithm.
//
// Node spells the decrypt side `createDecipheriv`, with a LOWERCASE c. Writing
// this as `create(?:De)?Cipher(?:iv)?` looks right and silently matches only
// the encrypt half, so a module that decrypts and never encrypts fails the gate
// and every algorithm check below it stops running. Caught 2026-07-27 by
// enumerating the call sites in a real corpus rather than trusting the pattern.
const CIPHER_API_RE =
  /\bcreate(?:Cipher|Decipher)(?:iv)?\s*\(|\bCryptoJS\s*\.\s*(?:AES|DES|TripleDES|RC4|Rabbit|RC2|Blowfish)\b|\bforge\s*\.\s*cipher\b|\bsubtle\s*\.\s*(?:encrypt|decrypt)\s*\(/;

// Deprecated passphrase-based cipher factories. `createCipheriv` /
// `createDecipheriv` must not match: `\s*\(` sits immediately after `Cipher`
// and `Decipher`, and the `iv` is in the way.
const LEGACY_CIPHER_RE = /\bcreate(?:Cipher|Decipher)\s*\(/g;

// Modes that reveal plaintext structure. `-ecb` is the whole signal; the
// algorithm in front of it does not matter.
const ECB_ALGO_RE = /['"]([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-ecb)['"]/gi;
const CRYPTOJS_ECB_RE = /\bCryptoJS\s*\.\s*mode\s*\.\s*ECB\b/;

// Ciphers that are broken or retired, in the exact spellings OpenSSL and Node
// accept. `seed` and `cast` are deliberately absent: both are ordinary English
// words that appear as string literals in normal code.
const BROKEN_CIPHER_ALGO_RE =
  /['"]((?:des(?:x|3|-ede3?)?|rc2|rc4|bf|blowfish|idea|cast5)(?:-(?:cbc|ecb|cfb(?:1|8|64)?|ofb|ctr|hmac-md5|40))?|3des(?:-[A-Za-z0-9]+)?)['"]/gi;

// Hashes, split by what they are wrong for.
//   md5 / sha1 / md4: broken for everything security-bearing, and catastrophic
//     for credentials.
//   sha256 / sha512: correct for integrity, wrong for passwords, and only for
//     passwords.
const CREATEHASH_RE = /\bcreateHash\s*\(\s*(['"])([A-Za-z0-9_-]+)\1/g;
const BROKEN_HASH_ALGOS = new Set(['md4', 'md5', 'sha1', 'sha-1', 'ripemd', 'ripemd160']);
const FAST_HASH_ALGOS = new Set(['sha256', 'sha-256', 'sha384', 'sha512', 'sha-512', 'sha224']);

// Credential context for md5/sha1. Broader than the password set: deriving a
// key from a master secret with md5 is the same class of mistake.
const CRED_CONTEXT_RE =
  /\b\w*(?:password|passwd|passphrase|pwd|plaintext|plain_text|credential|secret|api_?key|private_?key|master_?key|session_?key)\w*\b/i;

// Password context for sha256/sha512. Narrow on purpose: `createHash('sha256')`
// over a master key is a defensible if unfashionable KDF, and over a file is
// simply correct. Only a password makes it a finding.
const PASSWORD_CONTEXT_RE = /\b\w*(?:password|passwd|passphrase|pwd|plaintext|plain_text)\w*\b/i;

// Enclosing-function names that mean "this hash is a password hash" even when
// every local variable is a single letter.
const AUTH_FN_NAME_RE =
  /\b(?:hash_?pw|hash_?pass\w*|verify_?pass\w*|check_?pass\w*|compare_?pass\w*|login|log_?in|sign_?in|sign_?up|signup|register|authenticate|auth_?user|create_?user|set_?password|change_?password|reset_?password)\b/i;

// The counter-signal. md5 of a URL inside a function named `cacheKey` is a
// cache key even when the file is full of the word `password`.
const NON_CREDENTIAL_USE_RE =
  /\b\w*(?:cache|etag|e_tag|checksum|fingerprint|content_?hash|file_?hash|body_?hash|asset_?hash|bundle|manifest|gravatar|avatar|dedupe|dedup|idempoten\w*|shasum|md5sum|revision|digest_?file|integrity)\w*\b/i;

// A real KDF anywhere in the file means the fast hash is a component, not the
// whole password scheme. Same gate Auth Weakness applies.
const KDF_RE = /pbkdf2|hkdf|scrypt|bcrypt|argon2/i;

// --- Overlap with Auth Weakness -------------------------------------------
// src/lib/probes/auth.js already reports the narrow shape where the hashed
// value is literally named password/passwd/pwd/pw. These are its four regexes,
// reproduced so this probe can skip the lines it already covers. One bug, one
// finding: a user reading a report should never see the same line twice under
// two probe names.
const AUTH_WEAKHASH_CALL_RE = /\b(?:md5|sha1)\s*\([^)]*\b\w*(?:password|passwd|pwd|pw)\b/i;
const AUTH_WEAKHASH_CHAIN_RE =
  /createHash\(\s*['"](?:md5|sha1)['"]\s*\)\s*\.\s*update\s*\(\s*[^)]*?\b(?:password|passwd|pwd|pw)\b/i;
const AUTH_SHA256_CHAIN_RE =
  /createHash\(\s*['"]sha256['"]\s*\)\s*\.\s*update\s*\(\s*\b\w*(?:password|passwd|pwd)\b/i;
const AUTH_SHA256_CALL_RE = /\bsha256\s*\(\s*\b\w*(?:password|passwd|pwd)\b/i;

// --- IV classification -----------------------------------------------------
// A value produced by a CSPRNG is the correct IV and must stay silent.
const RANDOM_IV_RE =
  /\brandomBytes\s*\(|\brandomFillSync\s*\(|\brandomFill\s*\(|\bgetRandomValues\s*\(|\bwebcrypto\b|\bnanoid\s*\(|\brandomUUID\s*\(/;

// A value fixed at author time. Note what is NOT here: `Buffer.from(ivHex,
// 'hex')` with a VARIABLE first argument is how every correct decrypt path
// reads the IV back off the wire, and flagging it would flag the fix.
// `Buffer.alloc(16, 0)` takes an optional fill argument, and requiring the
// paren to close straight after the length meant the EXPLICIT zero IV was
// missed while the implicit one fired. That is backwards: the author who typed
// `, 0` said what they meant, and the author who typed `Buffer.alloc(16)` may
// not have known it zero-fills at all. `Buffer.alloc(16, 0)` is also the spelling
// in most tutorials, so it is the one that reaches production.
//
// The fill has to be a LITERAL. `Buffer.alloc(16, someByte)` could be anything,
// and guessing would cost the precision this check is built on.
// Verified across eighteen spellings by an independent checker, 2026-07-28.
const STATIC_IV_EXPR_RE =
  /^(?:['"][^'"]*['"]|Buffer\s*\.\s*from\s*\(\s*(?:['"]|\[)|Buffer\s*\.\s*alloc(?:Unsafe)?\s*\(\s*\d+\s*(?:,\s*(?:0[xX][0-9a-fA-F]+|\d+|['"][^'"]*['"]))?\s*\)|new\s+Uint8Array\s*\(\s*(?:\d+\s*\)|\[)|new\s+Array\s*\(\s*\d+\s*\)\s*\.\s*fill\s*\(\s*\d+\s*\))/;

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

const finding = (o) => ({
  probe: 'Weak Cryptography',
  category: 'Cryptographic Failure',
  ...o,
});

// Byte offset -> 1-based line number, via a prefix table built once per file.
function lineIndexer(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// Text between the parens of the call whose `(` sits at openIdx, quote- and
// nesting-aware, so a multi-line `createCipheriv(\n  algo,\n  key,\n  iv\n)`
// reads the same as the one-line form. Returns null when unbalanced.
function readCallArgText(code, openIdx) {
  let depth = 0;
  let quote = null;
  const limit = Math.min(code.length, openIdx + 4000);
  for (let i = openIdx; i < limit; i++) {
    const c = code[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return code.slice(openIdx + 1, i);
    }
  }
  return null;
}

function splitArgs(inner) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  args.push(inner.slice(start));
  return args.map((a) => a.replace(/\s+/g, ' ').trim());
}

// Nearest preceding line that opens a function, so `function hashPassword(p) {`
// is visible from the `createHash` three lines below it.
const FUNC_DECL_RE =
  /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*\(|(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:function\b|\(|[\w$]+\s*=>)|[\w$]+\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?:=>|\{))|(?:static\s+)?(?:async\s+)?[\w$]+\s*\([^;()]*\)\s*\{)/;
function enclosingSignature(lines, i) {
  for (let j = i; j >= Math.max(0, i - 30); j--) {
    if (FUNC_DECL_RE.test(lines[j])) return lines[j];
  }
  return '';
}

export function probeWeakCryptography(files) {
  const findings = [];

  files.forEach((file) => {
    if (isTestFile(file.path) || isScannerSelfSource(file.path)) return;
    if (!JS_TS_FILE_RE.test(file.path)) return;
    if (typeof file.content !== 'string' || !file.content) return;
    // Cheap gate ahead of the two masking passes, which are the expensive part
    // of this probe. Nothing below can fire without one of these tokens in the
    // bytes, and the raw view is a superset of both masked views, so this can
    // only skip files that had nothing to find. On a 2,271-file corpus it takes
    // the probe from 1.8s to under 100ms.
    if (!CRYPTO_TOKEN_RE.test(file.content)) return;

    // Two views of the same bytes, both index-preserving.
    //
    //   code  — comments and regex bodies blanked, string literals intact.
    //           This is the view that can read `'aes-256-ecb'`.
    //   shape — comments, regex bodies AND every string body blanked, with the
    //           quote delimiters left standing. This is the view that answers
    //           "is this real code?": a snippet pasted inside a template
    //           literal for documentation has its whole body blanked here, so
    //           `createCipheriv` in a doc string cannot fire.
    const code = maskCommentsForPath(file.path, file.content);
    const shape = maskCodeShapeForPath(file.path, file.content);
    const lines = code.split('\n');
    const rawLines = file.content.split('\n');
    const lineOf = lineIndexer(code);

    const isRealCodeAt = (idx, token) => shape.startsWith(token, idx);
    // A quoted literal survives in `shape` as its two delimiters around blanks.
    // Inside a template literal or a comment the delimiter is blanked too, so
    // this single character tells real source from quoted prose.
    const isRealStringAt = (idx) =>
      (shape[idx] === "'" || shape[idx] === '"') && !isMatchInsideTemplateLiteral(code, idx);

    const push = (o) => findings.push(finding({ ...o, file: file.path }));
    const evidenceAt = (ln) => (rawLines[ln - 1] ?? '').trim().slice(0, 200);

    const fileHasKdf = KDF_RE.test(code);
    const fileBuildsCipher = CIPHER_API_RE.test(shape) || CIPHER_API_RE.test(code);
    const reported = new Set(); // `${check}:${line}` — one finding per line per check

    const report = (check, ln, o) => {
      const key = `${check}:${ln}`;
      if (reported.has(key)) return;
      reported.add(key);
      push({
        id: `crypto-${check}-${file.path}-${ln}`,
        line: ln,
        evidence: evidenceAt(ln),
        ...o,
      });
    };

    // ---------------------------------------------------------------------
    // 1. Hashing a credential with a broken or fast hash.
    // ---------------------------------------------------------------------
    CREATEHASH_RE.lastIndex = 0;
    for (let m = CREATEHASH_RE.exec(code); m; m = CREATEHASH_RE.exec(code)) {
      if (!isRealCodeAt(m.index, 'createHash')) continue;
      const algo = m[2].toLowerCase();
      const broken = BROKEN_HASH_ALGOS.has(algo);
      const fast = FAST_HASH_ALGOS.has(algo);
      if (!broken && !fast) continue;

      const ln = lineOf(m.index);
      const i = ln - 1;
      const line = lines[i] ?? '';

      // What Auth Weakness already reports, so the user sees it once.
      if (broken && (AUTH_WEAKHASH_CALL_RE.test(line) || AUTH_WEAKHASH_CHAIN_RE.test(line)))
        continue;
      if (fast && (AUTH_SHA256_CHAIN_RE.test(line) || AUTH_SHA256_CALL_RE.test(line))) continue;

      // Context window: the chained `.update(...)` may sit on its own line, and
      // the only name that says "password" is often the function's.
      const signature = enclosingSignature(lines, i);
      const window = lines.slice(Math.max(0, i - 4), i + 5).join('\n');
      const context = `${signature}\n${window}`;

      // Cache key, ETag, checksum: correct use, stay silent. Judged on the call
      // line and the enclosing signature, not the whole window, so one unrelated
      // cache helper nearby cannot silence a real password hash.
      //
      // Named evidence beats the counter-signal. `hashPasswordFingerprint` is a
      // password hash; `cacheKey` in a file that happens to mention passwords
      // four lines away is a cache key. The distinction is WHERE the credential
      // word is: on the call line or in the signature it is deliberate, in the
      // surrounding window it is circumstantial.
      const namedCredential =
        CRED_CONTEXT_RE.test(line) ||
        CRED_CONTEXT_RE.test(signature) ||
        AUTH_FN_NAME_RE.test(signature);
      const nonCredentialUse =
        NON_CREDENTIAL_USE_RE.test(line) || NON_CREDENTIAL_USE_RE.test(signature);
      if (nonCredentialUse && !namedCredential) continue;

      if (broken) {
        if (!CRED_CONTEXT_RE.test(context) && !AUTH_FN_NAME_RE.test(signature)) continue;
        report('weakhash', ln, {
          title: `Credential hashed with ${m[2]}`,
          severity: 'critical',
          cwe: 'CWE-916',
          remediation:
            'md5 and sha1 run at billions of guesses a second on one rented GPU, so whoever takes a copy of this table takes the passwords in it, and every account that reused the password elsewhere. Store credentials with a slow, salted hash instead: await bcrypt.hash(password, 12) to write and await bcrypt.compare(input, stored) to check, or crypto.scrypt(password, salt, 64) if you want to stay in the standard library. Rehash each account on its next successful login rather than forcing a reset.',
        });
      } else {
        if (fileHasKdf) continue;
        if (!PASSWORD_CONTEXT_RE.test(context) && !AUTH_FN_NAME_RE.test(signature)) continue;
        report('fasthashpw', ln, {
          title: `Password hashed with ${m[2]} and no key derivation function`,
          severity: 'high',
          cwe: 'CWE-916',
          remediation:
            'sha256 is the right hash for a file digest and the wrong one for a password: it is fast by design and it does not salt, so an attacker who copies the table tries candidates as fast as their hardware allows and identical passwords show up as identical rows. Use await bcrypt.hash(password, 12), argon2id, or crypto.scrypt(password, salt, 64). If you have to keep sha256, run it inside crypto.pbkdf2 with at least 600000 iterations and a per-user salt.',
        });
      }
    }

    // ---------------------------------------------------------------------
    // 2. Cipher algorithm and mode. Gated on the file actually building a
    //    cipher, so an algorithm-shaped word in unrelated source stays quiet.
    // ---------------------------------------------------------------------
    if (fileBuildsCipher) {
      const brokenAlgoLines = new Set();

      BROKEN_CIPHER_ALGO_RE.lastIndex = 0;
      for (let m = BROKEN_CIPHER_ALGO_RE.exec(code); m; m = BROKEN_CIPHER_ALGO_RE.exec(code)) {
        if (!isRealStringAt(m.index)) continue;
        const ln = lineOf(m.index);
        brokenAlgoLines.add(ln);
        report('brokencipher', ln, {
          title: `Broken cipher algorithm "${m[1]}"`,
          severity: 'high',
          cwe: 'CWE-327',
          remediation:
            'DES has a 56-bit key, 3DES has 112 bits of effective strength and NIST withdrew it for new use, and RC4 and Blowfish both leak plaintext through known biases and a 64-bit block. Anyone who copies the ciphertext can recover it with rented compute, without ever touching your key. Replace the call with crypto.createCipheriv("aes-256-gcm", key, crypto.randomBytes(12)), keep the tag from cipher.getAuthTag(), and re-encrypt anything already stored under the old algorithm.',
        });
      }

      ECB_ALGO_RE.lastIndex = 0;
      for (let m = ECB_ALGO_RE.exec(code); m; m = ECB_ALGO_RE.exec(code)) {
        if (!isRealStringAt(m.index)) continue;
        const ln = lineOf(m.index);
        // `des-ecb` is both. Report the algorithm, which is the deeper problem,
        // and do not stack a second finding on the same line.
        if (brokenAlgoLines.has(ln)) continue;
        report('ecb', ln, {
          title: `ECB mode in "${m[1]}"`,
          severity: 'high',
          cwe: 'CWE-327',
          remediation:
            'ECB encrypts each 16-byte block on its own, so identical plaintext blocks come out as identical ciphertext blocks. Someone holding the ciphertext can see where records repeat, tell two users apart, and cut and paste blocks between messages without ever having the key. Use an authenticated mode: crypto.createCipheriv("aes-256-gcm", key, crypto.randomBytes(12)), store the tag from cipher.getAuthTag(), and pass it to decipher.setAuthTag(tag) before you decrypt.',
        });
      }

      if (CRYPTOJS_ECB_RE.test(shape)) {
        const idx = shape.search(CRYPTOJS_ECB_RE);
        report('ecb', lineOf(idx), {
          title: 'ECB mode selected in CryptoJS',
          severity: 'high',
          cwe: 'CWE-327',
          remediation:
            'CryptoJS.mode.ECB encrypts each block independently, so repeated plaintext is visible as repeated ciphertext and blocks can be reordered by anyone holding the message. Move this to the platform WebCrypto AES-GCM: crypto.subtle.encrypt({ name: "AES-GCM", iv: crypto.getRandomValues(new Uint8Array(12)) }, key, data). It authenticates the ciphertext as well as hiding it, which CryptoJS default modes do not.',
        });
      }

      // Deprecated passphrase factory: MD5 key derivation, zero IV. Matched on
      // `shape`, so the name appearing inside a doc string is not a call.
      LEGACY_CIPHER_RE.lastIndex = 0;
      for (let m = LEGACY_CIPHER_RE.exec(shape); m; m = LEGACY_CIPHER_RE.exec(shape)) {
        report('legacycipher', lineOf(m.index), {
          title: 'crypto.createCipher derives the key with MD5 and a zero IV',
          severity: 'high',
          cwe: 'CWE-327',
          remediation:
            'createCipher runs your passphrase through a single unsalted MD5 pass and then encrypts with an all-zero IV, so two users with the same passphrase produce byte-identical ciphertext and the key carries far less entropy than the passphrase suggests. Node removed it in v22. Switch to crypto.createCipheriv("aes-256-gcm", key, crypto.randomBytes(12)) with a key from crypto.scrypt(passphrase, salt, 32) or from your key manager.',
        });
      }

      // -------------------------------------------------------------------
      // 3. Fixed initialization vector.
      // -------------------------------------------------------------------
      // One-hop bindings, so `const IV = Buffer.from('0000...', 'hex')` two
      // lines up is visible at the call. A name that is EVER assigned a random
      // value is treated as random: reassignment beats a stale constant, and
      // the cost of being wrong in that direction is only a missed finding.
      const staticNames = new Set();
      const randomNames = new Set();
      lines.forEach((line) => {
        const m = line.match(/^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.+?);?\s*$/);
        if (!m) return;
        const rhs = m[2].trim();
        if (RANDOM_IV_RE.test(rhs)) randomNames.add(m[1]);
        else if (STATIC_IV_EXPR_RE.test(rhs)) staticNames.add(m[1]);
      });

      const classifyIv = (expr) => {
        const e = expr.trim();
        if (!e) return 'unknown';
        if (RANDOM_IV_RE.test(e)) return 'random';
        if (STATIC_IV_EXPR_RE.test(e)) return 'static';
        if (IDENTIFIER_RE.test(e)) {
          if (randomNames.has(e)) return 'random';
          if (staticNames.has(e)) return 'static';
        }
        return 'unknown';
      };

      // Encryption only. The decrypt side has to use whatever the encrypt side
      // chose, so the encrypt call is the line that actually gets edited, and
      // reporting both would bill one bug twice.
      const CIPHERIV_CALL_RE = /\bcreateCipheriv\s*\(/g;
      CIPHERIV_CALL_RE.lastIndex = 0;
      for (let m = CIPHERIV_CALL_RE.exec(shape); m; m = CIPHERIV_CALL_RE.exec(shape)) {
        const openIdx = shape.indexOf('(', m.index);
        const inner = readCallArgText(code, openIdx);
        if (inner === null) continue;
        const args = splitArgs(inner);
        if (args.length < 3) continue;
        const algo = (args[0].match(/['"]([^'"]+)['"]/) || [])[1] || '';
        // A null IV is only legal with ECB, and the ECB check already owns that
        // line. Everything else null throws at runtime rather than encrypting
        // badly, so it is a bug for a different tool.
        if (/-ecb$/i.test(algo)) continue;
        if (classifyIv(args[2]) !== 'static') continue;
        report('staticiv', lineOf(m.index), {
          title: 'Fixed initialization vector reused for every message',
          severity: 'high',
          cwe: 'CWE-329',
          remediation:
            'A constant IV makes the encryption deterministic: the same plaintext always produces the same ciphertext, so anyone reading the stored rows can tell which users share a value and can spot when a value changes back. With CBC, two messages that begin with the same bytes also produce the same opening blocks, which is how a JSON envelope or a login form gets fingerprinted. Generate a fresh IV per message with crypto.randomBytes(16), or 12 bytes for GCM, prepend it to the ciphertext, and slice it back off before you decrypt.',
        });
      }

      // WebCrypto passes the IV as an option rather than an argument.
      if (/\bsubtle\s*\.\s*(?:encrypt|decrypt)\s*\(/.test(shape)) {
        // `{ iv: iv }` fired and `{ iv }` did not, which had it exactly the
        // wrong way round: the shorthand is the idiomatic modern spelling and
        // therefore the common one. Matched here and resolved through the same
        // binding map the longhand uses, so both forms answer identically.
        const IV_PROP_RE = /\biv\s*(?::\s*([^,}\n]+)|(?=\s*[,}]))/g;
        IV_PROP_RE.lastIndex = 0;
        for (let m = IV_PROP_RE.exec(code); m; m = IV_PROP_RE.exec(code)) {
          if (!isRealCodeAt(m.index, 'iv')) continue;
          // Shorthand: the property name IS the binding name.
          const expr = m[1] === undefined ? 'iv' : m[1];
          if (classifyIv(expr) !== 'static') continue;
          report('staticiv', lineOf(m.index), {
            title: 'Fixed initialization vector passed to WebCrypto',
            severity: 'high',
            cwe: 'CWE-329',
            remediation:
              'AES-GCM with a repeated IV is worse than a repeated IV in CBC: reusing one nonce under the same key lets an attacker recover the authentication key and forge messages that your own code will accept as genuine. Build the IV fresh for every call with crypto.getRandomValues(new Uint8Array(12)), send it alongside the ciphertext, and pass the received value back on decrypt.',
          });
        }
      }
    }

    // -------------------------------------------------------------------
    // 4. Key derivation with a hardcoded salt, or too few iterations.
    // -------------------------------------------------------------------
    // Nothing checked KDF PARAMETERS anywhere in the registry. `scrypt` and
    // `pbkdf2` appeared only as a suppression gate — seeing one was taken as
    // evidence the author had done the right thing — so
    // `scryptSync(password, 'salt', 24)` read as a KDF in use and passed.
    //
    // A literal salt is most of the point thrown away. The salt exists so
    // that two people with the same password get different keys and so that
    // an attacker cannot precompute anything reusable. Share one across
    // every user and one table works against all of them at once.
    //
    // `crypto.scryptSync(password, 'salt', 24)` is the example in Node's own
    // documentation, which is exactly why it ends up in production.
    const KDF_CALL_RE =
      /\bcrypto\s*\.\s*(scrypt|scryptSync|pbkdf2|pbkdf2Sync)\s*\(\s*([^,]+),\s*([^,]+),\s*([^,)]+)/g;
    KDF_CALL_RE.lastIndex = 0;
    for (let m = KDF_CALL_RE.exec(code); m; m = KDF_CALL_RE.exec(code)) {
      if (!isRealCodeAt(m.index, 'crypto')) continue;
      const fn = m[1];
      const saltArg = m[3].trim();
      const ln = lineOf(m.index);
      // A quoted literal, or a Buffer built from one. A variable might hold
      // randomBytes and is left alone.
      //
      // One hop back covers the `const SALT = 'pepper'` spelling. Resolved
      // here rather than through the cipher block's binding map, because this
      // check deliberately runs on files that never build a cipher: a module
      // that only derives a key is exactly the case the file gate used to miss.
      let resolved = saltArg;
      if (IDENTIFIER_RE.test(saltArg)) {
        const decl = new RegExp(`(?:const|let|var)\\s+${saltArg}\\s*=\\s*([^;\\n]+)`).exec(code);
        if (decl) resolved = decl[1].trim();
      }
      const literalSalt =
        /^['"][^'"]*['"]$/.test(resolved) || /^Buffer\s*\.\s*from\s*\(\s*['"]/.test(resolved);
      if (literalSalt) {
        report('kdfsalt', ln, {
          title: `Key derivation with a hardcoded salt in ${fn}`,
          severity: 'high',
          cwe: 'CWE-760',
          remediation:
            'The salt is what stops one precomputed table working against every account, and a constant salt hands that back: two users with the same password derive the same key, and an attacker who builds a table for this one salt can reuse it against your whole database. Generate the salt per record with crypto.randomBytes(16), store it next to the derived value, and read it back when you verify. A salt is not a secret, it only has to be different every time.',
        });
      }
      // PBKDF2 iterations are argument three. OWASP's 2023 guidance is
      // 600,000 for PBKDF2-HMAC-SHA256; the threshold here is deliberately
      // far below that so only clearly-inadequate values report.
      if (/^pbkdf2/.test(fn)) {
        const iterations = Number((m[4] || '').trim().replace(/_/g, ''));
        if (Number.isFinite(iterations) && iterations > 0 && iterations < 100000) {
          report('kdfiterations', ln, {
            title: `Password-based key derivation with only ${iterations} iterations`,
            severity: 'medium',
            cwe: 'CWE-916',
            remediation:
              'The iteration count is the entire cost an attacker pays per guess, so a low one makes the derivation fast for them as well as for you. OWASP recommends 600000 iterations for PBKDF2-HMAC-SHA256. Raise it, or move to scrypt or argon2id, which are also memory-hard and therefore much worse to attack with a rented GPU.',
          });
        }
      }
    }
  });

  return findings;
}
