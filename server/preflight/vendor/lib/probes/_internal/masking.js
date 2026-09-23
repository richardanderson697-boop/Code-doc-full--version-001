// src/lib/probes/_internal/masking.js
//
// Comment/string/template-literal masking helpers + placeholder-name
// detection shared by probeSecrets, probeAuthWeakness, probeMCPSecurity,
// and probeClientAuthStorage. Extracted from the prior builtin.js
// monolith when it crossed the file-size HIGH threshold. The functions
// themselves are byte-identical to the original; only the location moved.

// Substrings inside a regex-matched value that obviously mark the value as a
// placeholder rather than a real secret. The list is intentionally broad
// because the cost of a single FP placeholder match is high (every "your-key"
// firing trains users to ignore the panel). False negatives from a real
// secret that happens to embed one of these substrings are improbable and
// would still be caught at runtime by the issuing service's own scanner.
//
// Matches: `AKIAXXXXXXXXXXXXXXXX`, `sk_live_xxxxxxxxxxxxxxxxxxxx`,
// `xoxb-REPLACE-ME-WITH-A-REAL-BOT-TOKEN`, `xoxp-DEMO-DEMO-DEMO-DEMO`,
// `sk-proj-REPLACE_THIS_BEFORE_RUNNING_LOCALLY`,
// `AKIAIOSFODNN7EXAMPLE` (the AWS-published documentation value),
// `<your-key-here>`.
export const SECRET_VALUE_PLACEHOLDER_RE =
  /x{4,}|REPLACE[_\-]?(?:ME|THIS|HERE|WITH|YOUR)?|YOUR[_\-]?(?:KEY|API|TOKEN|SECRET|PRIVATE|SLACK|AWS|STRIPE|OPENAI|ANTHROPIC|GITHUB|GOOGLE|[A-Z]+)[_\-A-Z]*HERE|YOUR[_\-]?(?:KEY|API|TOKEN|SECRET|PRIVATE)|PLACEHOLDER|DEMO[_\-]?(?:DEMO|TOKEN|KEY)?|EXAMPLE|<[^<>]+>|\{\{[^}]+\}\}|CHANGE[_\-]?ME|\bTODO(?:[_\-]\w+)*\b|FILL[_\-]?(?:IN|ME|HERE)|^stub[._-]/i;

// True when the match's enclosing statement assigns to a variable whose
// name explicitly marks it as a sample/example/test/fake fixture, e.g.
// `const SAMPLE_OPENAI_KEY = 'sk-proj-...'` or `const FAKE_STRIPE = 'sk_live_...'`.
// Both signals — explicit naming AND value shape — are required for suppression;
// generic names like `API_KEY` or `AWS_SECRET` continue to fire, since those
// are exactly what real leaked code looks like.
export const PLACEHOLDER_VAR_NAME_RE =
  /\b(?:SAMPLE|EXAMPLE|FAKE|DUMMY|MOCK|FIXTURE|PLACEHOLDER|STUB|NOT_?A_?REAL|TEST_(?:KEY|TOKEN|SECRET|API))[_A-Z0-9]*\s*[:=]/;
export function isMatchInPlaceholderNamedAssignment(content, matchIndex) {
  // Check the entire line containing the match. Looking only at content BEFORE
  // the match misses cases where a sibling secret pattern matches mid-identifier
  // (e.g. Generic-Hardcoded-Secret matching `API_KEY = "..."` from inside
  // TEST_API_KEY — the LHS identifier sits partly after the match index).
  const lineStart = content.lastIndexOf('\n', matchIndex - 1) + 1;
  const lineEnd = content.indexOf('\n', matchIndex);
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
  return PLACEHOLDER_VAR_NAME_RE.test(line);
}

// True when the match site lies inside a single-line // comment or an
// unterminated /* */ block comment. A documentation comment naming a secret
// shape ("// AKIAIOSFODNN7EXAMPLE is the AWS-documented sample value") is
// teaching, not leaking; suppress.
export function isMatchInsideComment(content, matchIndex) {
  const lineStart = content.lastIndexOf('\n', matchIndex - 1) + 1;
  const beforeOnLine = content.slice(lineStart, matchIndex);
  // // comment opened earlier on this line, before the match
  if (/\/\//.test(beforeOnLine)) return true;
  // Inside a /* ... */ block that opens before the match and hasn't closed
  const lastOpen = content.lastIndexOf('/*', matchIndex);
  if (lastOpen === -1) return false;
  const closeAfterOpen = content.indexOf('*/', lastOpen);
  if (closeAfterOpen === -1 || closeAfterOpen > matchIndex) return true;
  return false;
}

// Whole-file content masker. Walks the content
// once, replacing the *interior* of multi-line `/* ... */` blocks, `//` line
// comments, and `'`/`"`/backtick string literals with spaces while preserving
// every newline and the opening/closing delimiters themselves. The output has
// the same line count and same indices as the input, so probes that emit
// line numbers and slice positions stay correct. This is the version
// structural probes should use when the FP set includes patterns hidden
// inside multi-line comments or template-literal docstrings.
//
// ---------------------------------------------------------------------------
// One lexer, three views.
//
// There used to be two independent walkers here, and only one of them knew how
// to lex. The narrow one honoured backticks without tracking `'`/`"` at all, so
// a single backtick inside an ordinary quoted string opened a template literal
// that ran to the next backtick anywhere later in the file. Two things follow
// from that, and the second is the dangerous one:
//
//   1. Comment text between the phantom pair is emitted as code. That is how a
//      line reading `// Plaintext password comparison: \`a.password === b\``
//      became a CRITICAL finding against the file explaining the check.
//   2. Every real line the phantom swallowed is blanked, so masked checks never
//      run on it. On src/lib/probes/auth.js that hid 353 of 1371 lines, and on
//      src/lib/probes/llm.js 110 of 367. Silent, and in the worst direction:
//      the scan comes back cleaner because the scanner stopped looking.
//
// Backticks in comments are ordinary in documented code, so this fired on real
// projects, not just ours. Found 2026-07-27 scanning PreFlight from GitHub.
//
// The fix is to have exactly one walker that understands JS lexical structure —
// comments, strings, template literals, regex literals — and to vary only what
// it BLANKS. Every view is then blind to comments by construction, and none of
// them can desynchronise, because they all consume the source the same way.
// ---------------------------------------------------------------------------

/**
 * Lex `content` once and blank the interiors selected by `opts`, preserving
 * length, indices, newlines, and all delimiters.
 *
 * Comments and regex-literal bodies are blanked in every view: a comment is
 * prose, and a regex body is a pattern describing code rather than code that
 * runs. `/eval\s*\(/` is not a call to eval.
 *
 * @param {string} content
 * @param {{blankStrings?: boolean, blankTemplates?: boolean}} opts
 */
function maskSource(content, { blankStrings = false, blankTemplates = false } = {}) {
  if (typeof content !== 'string' || content.length === 0) return content || '';
  const out = [];
  const len = content.length;
  let i = 0;
  const blankExceptNewline = (ch) => (ch === '\n' ? '\n' : ' ');
  // Last non-whitespace character emitted, used only to tell a regex literal
  // from a division. Comments never update it, which is what we want: `x = /a/`
  // and `x = /* note */ /a/` must lex the same way.
  let lastSignificant = '';
  let lastSignificantIdx = -1;
  const isRegexPosition = () => {
    if (lastSignificant === '') return true; // start of file
    if (REGEX_ALLOWED_AFTER.test(lastSignificant)) return true;
    if (/[\w$]/.test(lastSignificant)) {
      let j = lastSignificantIdx;
      while (j >= 0 && /[\w$]/.test(content[j])) j--;
      return REGEX_ALLOWED_KEYWORDS.test(content.slice(j + 1, lastSignificantIdx + 1));
    }
    return false; // after ) ] or a literal, `/` is division
  };
  // Emit a regex literal with its body blanked. Returns the index just past the
  // flags, or 0 when this turned out not to be a regex after all.
  const consumeRegex = (start) => {
    let j = start + 1;
    let inClass = false;
    while (j < len) {
      const ch = content[j];
      if (ch === '\n') return 0; // regex literals cannot span lines
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (inClass) {
        if (ch === ']') inClass = false;
      } else if (ch === '[') inClass = true;
      else if (ch === '/') break;
      j++;
    }
    if (j >= len || content[j] !== '/') return 0;
    out.push('/');
    for (let k = start + 1; k < j; k++) out.push(' ');
    out.push('/');
    let f = j + 1;
    while (f < len && /[a-z]/i.test(content[f])) {
      out.push(content[f]);
      f++;
    }
    lastSignificant = '/'; // a regex ends an expression; the next `/` is division
    lastSignificantIdx = j;
    return f;
  };
  while (i < len) {
    const c = content[i];
    const c2 = i + 1 < len ? content[i + 1] : '';
    // Regex literal. Without this, the `"` in `String(s).replace(/[&<>"']/g, …)`
    // opens a string that runs to the next unrelated quote, blanking hundreds
    // of lines of real code. escapeHtml is in nearly every generated app, so
    // this silently truncated analysis on a large share of real projects
    // (real-scan finding 2026-07: it hid six unhandled promise chains and
    // every other masked-content check between lines 442 and 1098 of one file).
    if (c === '/' && c2 !== '/' && c2 !== '*' && isRegexPosition()) {
      const consumed = consumeRegex(i);
      if (consumed > 0) {
        i = consumed;
        continue;
      }
    }
    // /* block comment (may span lines)
    if (c === '/' && c2 === '*') {
      const end = content.indexOf('*/', i + 2);
      if (end === -1) {
        // No terminator anywhere. In real source an unclosed block comment is
        // rare; a `/*` with no `*/` is far more often this lexer meeting text
        // it has no mode for — JSX and HTML copy, where `src/data/*` is a glob
        // a human is reading, not a comment a compiler is skipping.
        //
        // Blanking to EOF on that guess cost 95 of the 187 lines of this
        // repo's own TermsView.jsx: every masked check stopped running at the
        // word "src/data/*" and nothing said so. Treat the `/*` as ordinary
        // text and keep lexing.
        //
        // The trade is deliberate and it is the lesson of the whole file: an
        // unterminated construct is evidence of a mis-lex, and for a scanner,
        // under-masking risks a false positive somebody can see, while
        // over-masking hides real code and looks like a clean result.
        out.push('/', '*');
        i += 2;
        continue;
      }
      out.push('/', '*');
      for (let j = i + 2; j < end; j++) out.push(blankExceptNewline(content[j]));
      out.push('*', '/');
      i = end + 2;
      continue;
    }
    // // line comment
    if (c === '/' && c2 === '/') {
      out.push('/', '/');
      let j = i + 2;
      while (j < len && content[j] !== '\n') {
        out.push(' ');
        j++;
      }
      i = j;
      continue;
    }
    // String literal: ' " or backtick. Template literals can span lines.
    // Every quote kind is CONSUMED here regardless of whether its body is
    // blanked, which is the property the old narrow walker lacked.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const blank = quote === '`' ? blankTemplates : blankStrings;
      const keep = (ch) => (blank ? blankExceptNewline(ch) : ch);
      const outLenBeforeQuote = out.length;
      out.push(quote);
      let j = i + 1;
      while (j < len) {
        if (content[j] === '\\' && j + 1 < len) {
          // Skip escape and the character it escapes; preserve newlines.
          out.push(keep(content[j]));
          out.push(keep(content[j + 1]));
          j += 2;
          continue;
        }
        if (content[j] === quote) break;
        // A non-template quote does not span lines. An unterminated one is a
        // lexing dead end, and running to the end of the file from it is how a
        // whole file silently stops being analysed. Stop at the newline and
        // treat the quote as ordinary punctuation instead.
        if (quote !== '`' && content[j] === '\n') break;
        out.push(keep(content[j]));
        j++;
      }
      if (j >= len) {
        // Unterminated at EOF. Same reasoning as the unclosed block comment
        // above: a lone backtick in JSX text ("the ` character starts a
        // template literal") would otherwise swallow the rest of the file.
        // Rewind and treat the quote as ordinary punctuation.
        out.length = outLenBeforeQuote;
        out.push(quote);
        i += 1;
        continue;
      }
      if (quote !== '`' && content[j] === '\n') {
        // Unterminated single-line string: resume normal lexing at the newline.
        i = j;
        continue;
      }
      out.push(quote);
      lastSignificant = quote; // a string ends an expression
      lastSignificantIdx = j;
      i = j + 1;
      continue;
    }
    out.push(c);
    if (!/\s/.test(c)) {
      lastSignificant = c;
      lastSignificantIdx = i;
    }
    i++;
  }
  return out.join('');
}

// Narrower mask for probes that scan per-line for real code patterns inside
// string literals (e.g. `localStorage.setItem('jwt', token)` — the literal
// 'jwt' MUST stay visible). This mask blanks block comments, line comments,
// regex bodies, and BACKTICK template literals. Single/double-quoted string
// content is preserved. Indices and newlines preserved.
export function maskBlockCommentsAndTemplateLiterals(content) {
  return maskSource(content, { blankStrings: false, blankTemplates: true });
}

// Comments (and regex bodies) only. Every string literal survives, including
// template literals and the URLs inside them.
//
// This is the view for checks that ask a question ABOUT A STRING VALUE — a
// connection string with `root:root@`, a storage key named `jwt`, an inline
// Basic-auth credential. Those checks used to read the raw line to get past
// `stripLineComments` mangling the `//` in a URL scheme, and reading the raw
// line is precisely what let comment prose back in.
export function maskCommentsOnly(content) {
  return maskSource(content, { blankStrings: false, blankTemplates: false });
}

// `#` to end of line, for the languages that comment that way. Quote-aware for
// the same reason the JS walker is: `'#'` inside a string is a character, and
// a URL fragment (`https://host/page#anchor`) is not a comment.
function maskHashComments(content) {
  if (typeof content !== 'string' || content.length === 0) return content || '';
  const out = [];
  const len = content.length;
  let i = 0;
  while (i < len) {
    const c = content[i];
    if (c === "'" || c === '"') {
      // Python triple quotes: consume as one literal so a `#` inside a
      // docstring does not read as a comment and a lone quote inside it does
      // not terminate the string.
      const triple = content.slice(i, i + 3);
      if (triple === "'''" || triple === '"""') {
        const end = content.indexOf(triple, i + 3);
        const stop = end === -1 ? len : end + 3;
        for (let j = i; j < stop; j++) out.push(content[j]);
        i = stop;
        continue;
      }
      out.push(c);
      let j = i + 1;
      while (j < len && content[j] !== c && content[j] !== '\n') {
        if (content[j] === '\\' && j + 1 < len) {
          out.push(content[j], content[j + 1]);
          j += 2;
          continue;
        }
        out.push(content[j]);
        j++;
      }
      if (j < len && content[j] === c) {
        out.push(c);
        i = j + 1;
      } else {
        i = j;
      }
      continue;
    }
    if (c === '#') {
      let j = i;
      while (j < len && content[j] !== '\n') {
        out.push(' ');
        j++;
      }
      i = j;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

// Comment syntax follows the language, so the "ignore comments" rule has to as
// well. A probe that scans Python with a JavaScript lexer is still reading
// every `#` line as if it were code.
//
// HTML deliberately gets no masking: it has no `//` comment form, and bare
// `https://` in markup would be read as one.
const SLASH_COMMENT_LANGS = /\.(?:[jt]sx?|mjs|cjs|go|java|c|h|cpp|cs|swift|kt|scala|rs)$/i;
const HASH_COMMENT_LANGS = /\.(?:py|rb|sh|bash|zsh|ya?ml|toml|tf|pl)$/i;

/**
 * Blank comment bodies using the comment syntax of `path`'s language.
 * String and template contents survive. Returns `content` unchanged for file
 * types with no supported line-comment form.
 */
export function maskCommentsForPath(path, content) {
  const p = typeof path === 'string' ? path : '';
  if (SLASH_COMMENT_LANGS.test(p)) return maskCommentsOnly(content);
  if (HASH_COMMENT_LANGS.test(p)) return maskHashComments(content);
  // PHP takes both forms.
  if (/\.php$/i.test(p)) return maskHashComments(maskCommentsOnly(content));
  return typeof content === 'string' ? content : '';
}

/**
 * Comments AND string contents blanked, in the comment syntax of `path`'s
 * language. The view for a check about code shape rather than string value.
 *
 * Composed rather than special-cased: the language-aware pass drops comments,
 * then the JS string lexer blanks quoted bodies. Both preserve length and
 * indices, so composing them is safe and offsets still point at real source.
 */
export function maskCodeShapeForPath(path, content) {
  return maskCommentsAndStringsFromContent(maskCommentsForPath(path, content));
}

// A `/` begins a regex literal when what precedes it cannot end an expression.
// After an identifier, a number, `)` or `]`, a slash is division. After an
// operator, an opening bracket, a comma, a semicolon, or a keyword, it is a
// regex. This is the standard lexical disambiguation and it is right for every
// shape that appears in real source.
const REGEX_ALLOWED_AFTER = /[({[,;:=!&|?+\-*%^~<>]/;
const REGEX_ALLOWED_KEYWORDS =
  /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

// The widest view: comments, regex bodies, and every string literal blanked.
// This is what a check should use when it asks a question about CODE SHAPE —
// a comparison, a call, an assignment. A password comparison written inside a
// string literal is prose about a password comparison.
export function maskCommentsAndStringsFromContent(content) {
  return maskSource(content, { blankStrings: true, blankTemplates: true });
}

// True when a Private Key Block match should be SUPPRESSED. Two cases:
//   1. A matching END marker exists nearby and the body contains placeholder
//      markers (the canonical "documentation PEM" shape).
//   2. No END marker exists within a reasonable window — this is a framing
//      reference, not a key. Real PEM blocks always pair BEGIN and END within
//      ~50 lines because the body is dense base64; an unaccompanied BEGIN is
//      either a constant naming the framing (`export const BEGIN = '-----...'`)
//      or a documentation snippet truncated to the header.
export function isPEMBodyPlaceholderOrHeaderOnly(content, beginIndex) {
  const afterBegin = content.slice(beginIndex);
  const endIdx = afterBegin.search(/-----END /);
  // No END within the search window: framing-only reference, suppress.
  if (endIdx === -1) return true;
  if (endIdx > 4000) return true; // body too far to be a real PEM body
  const body = afterBegin.slice(0, endIdx);
  // Placeholder markers in the body (REPLACE_WITH_YOUR_KEY, EXAMPLE, ...).
  if (SECRET_VALUE_PLACEHOLDER_RE.test(body)) return true;
  // Framing-as-constants shape: `const BEGIN = '-----BEGIN ...'; const END = '-----END ...'`.
  // Real PEM bodies are dense base64 lines with no JS quotes, semicolons, or
  // language keywords. The presence of any of those between BEGIN and END
  // means we're looking at code that declares the framing as constants, not
  // a key body. Suppress.
  if (/['";]|\bexport\b|\bconst\b|\blet\b|\bvar\b|\bfunction\b/.test(body)) return true;
  return false;
}

// True when the match site lies inside a backtick-delimited template literal
// that is NOT itself the value being assigned to a variable (i.e., the
// template literal contains text that LOOKS like code — a documentation
// snippet, JSX child string, or similar). The simplest reliable signal is
// the parity of unescaped backticks before the match: an odd count means
// the match is between opening and closing backticks of a template literal.
//
// This produces a small recall sacrifice on the rare case of a secret stored
// in a template literal that wraps the value (e.g. `const k = `sk-live-...`;`)
// but eliminates the much more common precision failure: documentation
// strings that quote a secret-shaped example via backticks. The recall risk
// is acceptable because secrets pinned via backticks are unusual in real
// code; production keys are almost always pinned via single or double quotes.
export function isMatchInsideTemplateLiteral(content, matchIndex) {
  let count = 0;
  for (let i = 0; i < matchIndex; i++) {
    if (content[i] === '\\' && i + 1 < content.length) {
      i++;
      continue;
    }
    if (content[i] === '`') count++;
  }
  return count % 2 === 1;
}
