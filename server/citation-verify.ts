// Citation grounding for LLM-written report text ("verify citations").
//
// The deterministic assessment's evidence is computed from scan data, but the
// model's free-text reasons can cite files and lines nothing checks. Before a
// report reaches anyone, every `file:line` citation in those reasons is
// verified against the actual workspace files: the file must exist, the line
// must be in range, and any code quoted in the same sentence must appear near
// the cited line. Unsupported citations are dropped (never invented, never
// repaired into plausibility); a reason left with nothing to stand on falls
// back to caller-supplied deterministic text.

export interface CitationVerification {
  citationsChecked: number;
  citationsDropped: number;
  /** The dropped citation tokens, capped — for transparency, not for display. */
  droppedCitations: string[];
  importsRepaired: number;
}

interface FileIndex {
  lines: string[];
  lineCount: number;
}

// Matches `path/to/file.ts:123` and `path/to/file.ts line 123`. The extension
// requirement keeps version strings ("1.2.0:") and URLs out.
const CITATION_RE =
  /([A-Za-z0-9_@][\w\-./]*\.(ts|tsx|js|jsx|mjs|cjs|json|sql|css|html|md|py|go|rs|java|rb|php|vue|svelte))\s*(?::|line\s+)(\d+)/gi;
// Backtick-quoted code spans (single-line, bounded so prose can't swallow the doc).
const QUOTE_RE = /`([^`\n]{1,200})`/g;
const SENTENCE_RE = /(?<=[.!?])\s+/;
// Radius (lines) within which a quoted snippet must appear near its citation.
const QUOTE_RADIUS = 5;

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function quoteNearLine(index: FileIndex, quote: string, line: number): boolean {
  const q = normalize(quote);
  if (!q) return true;
  const start = Math.max(1, line - QUOTE_RADIUS);
  const end = Math.min(index.lineCount, line + QUOTE_RADIUS);
  for (let n = start; n <= end; n++) {
    if (normalize(index.lines[n - 1]).includes(q)) return true;
  }
  return false;
}

interface Cite {
  token: string;
  path: string;
  line: number;
}

function citationsIn(sentence: string): Cite[] {
  CITATION_RE.lastIndex = 0;
  const out: Cite[] = [];
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(sentence)) !== null) {
    out.push({ token: m[0], path: m[1], line: parseInt(m[3], 10) });
  }
  return out;
}

function quotesIn(sentence: string): string[] {
  QUOTE_RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = QUOTE_RE.exec(sentence)) !== null) out.push(m[0]);
  return out;
}

function citationSupported(cite: Cite, quotes: string[], files: Map<string, FileIndex>): boolean {
  const idx = files.get(cite.path);
  if (!idx) return false;
  if (cite.line < 1 || cite.line > idx.lineCount) return false;
  if (quotes.length === 0) return true;
  return quotes.some((q) => quoteNearLine(idx, q.slice(1, -1), cite.line));
}

/**
 * Verify every `file:line` citation in a free-text string. Unsupported
 * citations (and quotes that only ever appeared beside them) are removed.
 * Returns the cleaned text; `state` accumulates counts across calls.
 */
export function verifyTextCitations(
  text: string,
  files: Map<string, FileIndex>,
  state: { checked: number; dropped: string[] }
): string {
  if (!text) return text;
  // Processed per sentence so a citation that is valid in one sentence is
  // never removed because it failed in another.
  const outSentences: string[] = [];
  for (const sentence of text.split(SENTENCE_RE)) {
    let s = sentence;
    const cites = citationsIn(sentence);
    if (cites.length > 0) {
      const quotes = quotesIn(sentence);
      const supported = cites.filter((c) => citationSupported(c, quotes, files));
      for (const c of cites) {
        state.checked++;
        if (!supported.includes(c)) {
          state.dropped.push(c.token);
          s = s.split(c.token).join("");
        }
      }
      // A quote that matches no surviving citation in its sentence was only
      // ever evidence for a dropped claim — remove it too.
      for (const q of quotes) {
        const kept = supported.some((c) => {
          const idx = files.get(c.path)!;
          return quoteNearLine(idx, q.slice(1, -1), c.line);
        });
        if (!kept) s = s.split(q).join("");
      }
    }
    outSentences.push(s);
  }
  // Tidy the holes left behind: empty parens, doubled spaces, dangling punctuation.
  return outSentences
    .join(" ")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface VerifyReportOptions {
  /** Deterministic fallback when a category reason collapses. */
  categoryReason: (key: string) => string;
  /** Deterministic fallback when a missing-feature reason collapses. */
  missingReason: (feature: string) => string;
}

/**
 * Run citation verification over an assembled intelligence report object
 * (mutated in place): category reasons, missing-feature reasons, and the
 * file ledger. Returns the verification counts.
 */
export function verifyReportCitations(
  report: any,
  files: Array<{ path: string; content: string }>,
  opts: VerifyReportOptions
): Omit<CitationVerification, "importsRepaired"> {
  const index = new Map<string, FileIndex>();
  for (const f of files) {
    const lines = f.content.split("\n");
    index.set(f.path, { lines, lineCount: lines.length });
  }
  const state = { checked: 0, dropped: [] as string[] };

  const cleanReason = (reason: unknown, fallback: string): string => {
    if (typeof reason !== "string" || !reason.trim()) return fallback;
    const cleaned = verifyTextCitations(reason, index, state);
    return cleaned.replace(/\s/g, "").length >= 20 ? cleaned : fallback;
  };

  if (report?.categoryScores && typeof report.categoryScores === "object") {
    for (const key of Object.keys(report.categoryScores)) {
      const cat = report.categoryScores[key];
      if (cat && typeof cat === "object") {
        cat.reason = cleanReason(cat.reason, opts.categoryReason(key));
      }
    }
  }
  if (Array.isArray(report?.missingFeatures)) {
    for (const m of report.missingFeatures) {
      if (m && typeof m === "object") {
        m.reason = cleanReason(m.reason, opts.missingReason(String(m.feature ?? "this item")));
      }
    }
  }
  if (Array.isArray(report?.fileLedger)) {
    for (const entry of report.fileLedger) {
      if (entry && typeof entry === "object") {
        if (typeof entry.description === "string") {
          entry.description = verifyTextCitations(entry.description, index, state);
        }
        if (typeof entry.contribution === "string") {
          entry.contribution = verifyTextCitations(entry.contribution, index, state);
        }
      }
    }
  }

  return {
    citationsChecked: state.checked,
    citationsDropped: state.dropped.length,
    droppedCitations: state.dropped.slice(0, 10),
  };
}

/**
 * Repair the model's applicationMap imports against the deterministic import
 * map (ground truth). Components whose filePath matches a scanned file get
 * the exact scanned import list; anything else is left untouched. Returns
 * the number of components repaired.
 */
export function repairImportMap(
  report: any,
  importMap: Array<{ path: string; imports: string[] }>
): number {
  const groundTruth = new Map(importMap.map((e) => [e.path, e.imports]));
  const components = report?.applicationMap?.components;
  if (!Array.isArray(components)) return 0;
  let repaired = 0;
  for (const c of components) {
    if (!c || typeof c !== "object") continue;
    const gt = groundTruth.get(c.filePath);
    if (gt && Array.isArray(c.imports) && JSON.stringify(c.imports) !== JSON.stringify(gt)) {
      c.imports = [...gt];
      repaired++;
    }
  }
  return repaired;
}
