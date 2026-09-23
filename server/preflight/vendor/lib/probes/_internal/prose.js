// src/lib/probes/_internal/prose.js
//
// Telling English apart from source.
//
// Two checks kept reporting documentation as a defect, for the same reason:
// both asked "does this text contain a code keyword" and English contains code
// keywords constantly. `if`, `for`, `return`, `class`, `export` and `in` are
// ordinary words.
//
//   - The commented-out-code check read every file-header block as a run of
//     disabled code. A line like "does any FILE_INCLUDE regex match, no
//     FILE_EXCLUDE hit" counts as code because it contains `does` inside a
//     word boundary scan, and a well-documented file scored worse than an
//     undocumented one.
//   - The string-literal checks read remediation copy as the thing it
//     describes. "Same identifier for user AND password is the strongest
//     signal" is a sentence about default credentials, not a credential.
//
// The discriminator that actually works is grammar, not vocabulary. English
// prose is mostly function words — articles, prepositions, auxiliaries — and
// source code has almost none of them, because code names things and English
// relates them. A line with five or more words where a fifth of them are
// function words is a sentence. `const persistConfig = { key: 'auth' }` has
// none.

// Closed-class English words. Deliberately excludes anything that reads
// naturally as an identifier (`type`, `name`, `value`, `data`, `key`) and
// anything a code line uses structurally often enough to skew the ratio.
const FUNCTION_WORDS =
  /\b(?:a|an|the|is|are|was|were|be|been|being|am|that|which|who|whom|whose|this|these|those|and|or|but|nor|not|with|without|from|into|onto|than|then|when|where|what|why|how|it|its|you|your|yours|we|us|our|they|them|their|he|she|his|her|as|at|by|on|to|of|in|for|if|so|do|does|did|done|no|any|all|every|each|only|just|still|because|since|while|until|never|always|often|would|should|could|can|cannot|may|might|must|will|shall|have|has|had|there|here|about|after|before|between|through|over|under|above|below|again|same|other|another|more|most|less|least|own|both|either|neither|too|very|much|many|some|such|per|via)\b/gi;

// Punctuation that is structural in source and rare in a sentence.
const CODE_PUNCT = /[;{}[\]()<>=+*/\\|&^~`$#@]/g;

// Shapes that settle it outright: whatever the word ratio says, this is code.
const DECIDING_CODE_SHAPES = [
  /[;{]\s*$/, // statement or block terminator
  /=>/, // arrow function
  /\b(?:function|=>)\s*\(/, // function expression
  /^\s*(?:const|let|var)\s+[\w$]+\s*=/, // declaration with initialiser
  /^\s*(?:import|export)\s/, // module syntax
  /^\s*(?:if|for|while|switch|catch)\s*\(/, // control flow with a condition
  /^\s*(?:return|throw|await)\s+[\w$[({'"`]/, // statement keyword + operand
  /^\s*[\w$.]+\s*[:=]\s*(?:\{|\[|function|async|\()/, // property bound to a structure
];

/**
 * True when `text` reads as an English sentence rather than source code.
 *
 * KNOWN LIMIT, and it decides where this may be used. These are four
 * thresholds, not an ambiguity test, and SQL clears all of them: it is
 * English-shaped, keyword-heavy and punctuation-light. Measured true for
 * `SELECT * FROM users WHERE id = ` (function-word ratio 0.29) and for
 * `GRANT ALL PRIVILEGES ON *.* TO 'app'@'%' IDENTIFIED BY 'letmein'`. The same
 * holds for VB, AppleScript, and pg_hba lines.
 *
 * So: do NOT wire this guard into a SQL-injection, XSS or command-injection
 * probe. It is for checks whose false positives come from documentation prose
 * quoting a pattern, and every caller must pass a line that is a string
 * literal and nothing else — see `lineIsProseString`, which enforces that.
 *
 * An earlier version of this comment claimed the function was conservative and
 * returned false when ambiguous. It does not; that was the author describing
 * an intention rather than the code. Recorded here because a confident comment
 * that has not been checked is exactly how the last two bugs survived review.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeProse(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;

  // A decisive code shape ends it. A sentence does not close a block.
  for (const re of DECIDING_CODE_SHAPES) {
    if (re.test(s)) return false;
  }

  const words = s.split(/\s+/).filter(Boolean);
  // Too short to read grammar off. Three words is a label ("eval() usage
  // detected"), not a sentence, and guessing on it costs more than it saves.
  if (words.length < 5) return false;

  const functionWords = (s.match(FUNCTION_WORDS) || []).length;
  const ratio = functionWords / words.length;
  if (ratio < 0.18) return false;

  // Sentences are mostly letters and spaces. A line dense in brackets and
  // operators is code that happens to contain English.
  const punct = (s.match(CODE_PUNCT) || []).length;
  if (punct / s.length > 0.08) return false;

  // Identifier-shaped tokens (camelCase, snake_case, dotted paths) are the
  // vocabulary of code. A couple inside a sentence is normal — documentation
  // names what it documents — but a majority means this is a code line.
  const identifierish = words.filter((w) =>
    /^[\w$]*(?:[a-z][A-Z]|_[a-z]|\.[a-z$_])[\w$.]*$/.test(w)
  ).length;
  if (identifierish / words.length > 0.4) return false;

  return true;
}

/**
 * True when `line` is carrying a string literal whose contents read as prose.
 *
 * The cheap form of the guard below, for probes that already iterate per line
 * and have no byte offset to hand. It answers the common shape directly: a
 * remediation or teaching string, alone on its line, quoting the pattern the
 * probe is looking for.
 *
 * @param {string} line
 */
export function lineIsProseString(line) {
  const s = String(line ?? '').trim();
  if (!s) return false;
  // Strip a leading binding — `title:`, `remediation =`, `const note =`,
  // `export const x =`, or a `+` continuation — so the ordinary way of
  // writing a documentation string still qualifies.
  const body = s
    .replace(/^export\s+/, '')
    .replace(/^(?:const|let|var)\s+/, '')
    .replace(/^[\w$.]+\s*[:=]\s*/, '')
    // A ternary branch on its own line is how Prettier formats a conditional
    // title or message, so the leading `?` / `:` is punctuation, not code.
    // Without this, an adapter's own title strings sat in `? '...'` branches
    // and reported themselves as findings.
    .replace(/^[?:]\s*/, '')
    .replace(/^\+\s*/, '');
  // What remains must BE a string literal and nothing else, give or take
  // trailing punctuation.
  //
  // The first version asked whether the line CONTAINED a prose span, and every
  // caller uses the answer to skip the whole line. One human-readable sibling
  // property was therefore enough to switch off every check on that line:
  //
  //   const t = jwt.sign({ sub: id, note: 'we only issue this for the partner
  //     integration and nobody else should be using it' }, null, { algorithm: 'none' })
  //
  // — a critical, silenced by a comment-shaped property next to it. That is
  // not a crafted evasion; it is how people write code. Found 2026-07-27 by an
  // adversarial pass, the same day the guard shipped.
  const m = body.match(/^(['"`])((?:\\.|(?!\1)[\s\S])*)\1\s*[,;)\]}]*$/);
  if (!m) return false;
  return looksLikeProse(m[2]);
}
