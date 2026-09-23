// src/lib/probes/_internal/html-sinks.js
//
// "Did the author write this HTML, or did something else?" — the one question
// every HTML sink check comes down to, and the classifier that answers it.
//
// The classifier (HTML_SANITIZER_RE, extractHtmlValue, isTaintableHtmlValue)
// moved here from probes/auth.js unchanged when the Vue/Svelte template reader
// and the hoisted-`__html` resolver were added, for the same reason auth.js was
// split out of builtin.js: the file was approaching the size at which PreFlight
// reports its own source. Bodies are byte-identical; only the location moved.

import { collectSafeBindings, resolvesToConstant } from './const-eval.js';

const escapeIdent = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Known HTML sanitizers. A value wrapped in one of these has been through the
// escaping step the finding would have asked for, so flagging it is telling the
// author to do what they already did.
export const HTML_SANITIZER_RE =
  /\b(?:DOMPurify\s*\.\s*sanitize|sanitizeHtml|sanitize_html|xss|he\s*\.\s*encode|escapeHtml|escape_html|validator\s*\.\s*escape|purify\s*\.\s*sanitize)\s*\(/;

// Pull the expression assigned to __html, following up to three lines so the
// common prettier-wrapped form is covered:
//   dangerouslySetInnerHTML={{
//     __html: value,
//   }}
// Returns null when no __html key is present on the line or its continuation.
export function extractHtmlValue(line, lines, idx) {
  const span = lines
    .slice(idx, Math.min(lines.length, idx + 3))
    .join('\n')
    .replace(/\n\s*/g, ' ');
  const m = span.match(/__html\s*:\s*([\s\S]*?)(?:,\s*\}|\}\s*\}|\s*\}\s*$)/);
  if (!m) return null;
  return m[1].trim();
}

// True when the value could carry attacker-controlled HTML. A literal the
// author typed cannot; anything computed might.
//
// `bindings` is the same-file constant map from collectSafeBindings. Real-scan
// finding 2026-07 (Atlan cockpit): without it, every one of a 22-finding XSS
// report was a false positive, because the classifier could see that a value
// was an expression but not that the expression resolves to a constant.
export function isTaintableHtmlValue(value, bindings) {
  if (!value) return false;
  // Sanitized at the sink by a well-known library.
  if (HTML_SANITIZER_RE.test(value)) return false;
  // A plain string literal with no interpolation. Empty string included.
  if (/^'[^']*'$/.test(value) || /^"[^"]*"$/.test(value)) return false;
  // A template literal with no ${} substitution is still a constant.
  if (/^`[^`]*`$/.test(value) && !/\$\{/.test(value)) return false;
  // Resolves to something the author wrote: a const literal, a numeric value,
  // the author's own escaper, or a function that only returns literals.
  if (resolvesToConstant(value, bindings)) return false;
  return true;
}

// Read one object-property value starting just after its colon. Stops at the
// top-level comma or the closing brace, and steps over strings, template
// substitutions and nested brackets so none of those ends it early.
//
// The three-line span heuristic `extractHtmlValue` uses is right for the inline
// form, where the object is the last thing on the line and `}}` terminates it.
// It over-reads a hoisted declaration: `const markup = { __html: '<b>hi</b>' };`
// followed by the JSX line has no `}}`, so the capture runs past the statement
// and a plain string literal stops looking like one.
function readObjectPropertyValue(content, startIdx) {
  let i = startIdx;
  while (i < content.length && /\s/.test(content[i])) i++;
  const start = i;
  let depth = 0;
  let quote = null;
  let tmplDepth = 0;
  for (; i < content.length && i < start + 4000; i++) {
    const ch = content[i];
    const prev = content[i - 1];
    if (quote) {
      if (ch === quote && prev !== '\\') {
        if (quote === '`' && tmplDepth > 0) continue;
        quote = null;
      } else if (quote === '`' && ch === '$' && content[i + 1] === '{') {
        tmplDepth++;
        i++;
      } else if (quote === '`' && ch === '}' && tmplDepth > 0) {
        tmplDepth--;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
    } else if (ch === ',' && depth === 0) break;
  }
  return content.slice(start, i).trim();
}

// `dangerouslySetInnerHTML={markup}` where markup is a `{ __html: ... }` object
// declared elsewhere in the file. Hoisting the object out of JSX is the shape
// prettier and most generated components produce once the value needs any work
// done to it, and reading only the JSX line finds no `__html` and says nothing.
//
// Two views, because the two questions are different and both masks preserve
// indices, so offsets found in one read correctly in the other:
//   - `shapeContent` (comments and string bodies blanked) locates the
//     declaration. A sentence quoting `const markup = { __html: post.body }` is
//     prose about the defect, and it must not supply one.
//   - `valueContent` (comments blanked, strings intact) reads the value, so an
//     author-written literal still reads as a literal.
//
// Returns { value, line } for the declaration, or null.
export function resolveHtmlHolder(name, shapeContent, valueContent) {
  if (!name) return null;
  const declRe = new RegExp(String.raw`\b(?:const|let|var)\s+${escapeIdent(name)}\s*=\s*\{`, 'g');
  const m = declRe.exec(shapeContent);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  // Walk to the matching close brace so a later unrelated `__html` cannot be
  // read as this object's.
  let depth = 0;
  let end = openIdx;
  for (; end < shapeContent.length && end < openIdx + 4000; end++) {
    const ch = shapeContent[end];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const key = shapeContent.slice(openIdx, end + 1).match(/__html\s*:/);
  if (!key) return null;
  const value = readObjectPropertyValue(valueContent, openIdx + key.index + key[0].length);
  if (!value) return null;
  return { value, line: shapeContent.slice(0, m.index).split('\n').length - 1 };
}

// --- Vue / Svelte template HTML sinks (CWE-79) -----------------------------
//
// `.vue` and `.svelte` are both in FILE_INCLUDE and both were read only for the
// checks that happen to be extension-agnostic. The one sink each framework
// documents as an escape hatch, Vue's `v-html` and Svelte's `{@html}`, was
// matched only inside `.jsx`/`.tsx`, where neither ever appears.
//
// Blank the parts of the file that are not template: `<script>` and `<style>`
// bodies, then HTML comments. Blanking is length-preserving, so line numbers
// computed off the result still point at real source. Doing it this way means a
// `// <div v-html="x">` written inside the script block is out of scope by
// construction, and `<!-- <div v-html="x"></div> -->` is blanked.
const MARKUP_SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const MARKUP_STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const MARKUP_COMMENT_RE = /<!--[\s\S]*?-->/g;
const VUE_V_HTML_RE = /\bv-html\s*=\s*(["'])([\s\S]*?)\1/g;
const SVELTE_AT_HTML_RE = /\{@html\s+([^}]*)\}/g;

function blankMatches(content, re) {
  return content.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

function markupTemplateView(content) {
  let out = blankMatches(content, MARKUP_SCRIPT_RE);
  out = blankMatches(out, MARKUP_STYLE_RE);
  return blankMatches(out, MARKUP_COMMENT_RE);
}

export function probeMarkupHtmlSinks(file) {
  const findings = [];
  const template = markupTemplateView(file.content);
  // Bindings come from the WHOLE file: the constant a template renders is
  // declared in the script block above it.
  const bindings = collectSafeBindings(file.content);
  const originalLines = file.content.split('\n');
  const isVue = /\.vue$/i.test(file.path);
  const scans = isVue
    ? [{ re: VUE_V_HTML_RE, group: 2, sink: 'v-html' }]
    : [{ re: SVELTE_AT_HTML_RE, group: 1, sink: '{@html}' }];
  for (const { re, group, sink } of scans) {
    re.lastIndex = 0;
    for (const m of template.matchAll(re)) {
      const value = (m[group] || '').trim();
      if (!isTaintableHtmlValue(value, bindings)) continue;
      const lineIdx = template.slice(0, m.index).split('\n').length - 1;
      findings.push({
        id: `code-xss-${file.path}-${lineIdx}`,
        probe: 'Code Injection',
        title: 'Unsafe HTML/JS sink (XSS surface)',
        severity: 'medium',
        category: 'Code Injection',
        cwe: 'CWE-79',
        file: file.path,
        line: lineIdx + 1,
        evidence: (originalLines[lineIdx] || '').trim().slice(0, 200),
        remediation: `${sink} parses its input as HTML instead of escaping it, so whatever reaches ${value} is rendered as markup. Bind the text normally (${
          isVue ? '{{ value }} or v-text' : '{value}'
        }) when you only need text. If the value really is HTML, sanitize it where it is produced with DOMPurify.sanitize(value) and render the sanitized result. A string literal written in the source is not flagged, because a constant cannot carry an injection.`,
      });
    }
  }
  return findings;
}
