// Pure README identity extraction for the FinalRead report header.
//
// The stakeholder report must identify its subject. The most prominent
// identifier is usually the README's own H1 ("Automate-AI-v3"), yet the
// report used to print the generic fallback because nothing ever derived
// a title from the scanned files. These helpers are deterministic and
// side-effect free so the header chain can be unit-tested without a DB.
//
// Display rule they serve (first present wins): caller-supplied title >
// README H1 > GitHub owner/repo > ZIP filename > "Reviewed project".

/** A workspace file as the intelligence route holds it. */
export interface ReadmeCandidate {
  path: string;
  content: string;
}

/** The README of a workspace: case-insensitive basename match, root first. */
export function findReadmeFile(
  files: ReadmeCandidate[]
): ReadmeCandidate | undefined {
  const candidates = files.filter((f) => /(^|\/)readme\.md$/i.test(f.path));
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => {
    const depthA = a.path.split("/").length;
    const depthB = b.path.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.path.localeCompare(b.path);
  });
  return candidates[0];
}

// Strip leading/trailing emoji, variation selectors, joiners, and space
// from a heading so "# Automate-AI-v3 🏎️🤖" displays as "Automate-AI-v3".
function stripEdgeEmoji(text: string): string {
  return text
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u, "")
    .trim();
}

// Strip light inline-markdown decoration (backticks, bold markers, links)
// so a heading displays as plain text.
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(`{1,3}|[*_]{1,2})/g, "")
    .trim();
}

/** First ATX H1 of a README, cleaned for display. Nothing else qualifies. */
export function extractReadmeTitle(content: string): string | undefined {
  if (!content) return undefined;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (!m) continue;
    // Closed ATX ("# Title #") leaves trailing hashes behind.
    const heading = m[1].replace(/\s+#+\s*$/, "").trim();
    const cleaned = stripEdgeEmoji(stripInlineMarkdown(heading));
    return cleaned || undefined;
  }
  return undefined;
}

function isBadgeOrHtmlLine(line: string): boolean {
  return (
    line.startsWith("![") ||
    line.startsWith("[!") ||
    line.startsWith("<") ||
    line.startsWith("<!--") ||
    /^[-*_]{3,}$/.test(line) ||
    line.startsWith(">")
  );
}

/**
 * Tagline: the first real paragraph line of a README, skipping badges,
 * HTML, and blank lines. A heading before any paragraph ends the search,
 * so a "Key Features" section never donates its first bullet as the
 * description. Only the first line is returned — a wrapped paragraph is
 * truncated rather than pasted whole into the header — and the tagline is
 * only a fallback for when the intelligence summary is absent.
 */
export function extractReadmeTagline(content: string): string | undefined {
  if (!content) return undefined;
  let seenH1 = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip the title H1 itself, but any later heading ends the search.
    if (/^#\s+/.test(line)) {
      if (!seenH1) {
        seenH1 = true;
        continue;
      }
      return undefined;
    }
    if (line.startsWith("#")) return undefined;
    if (isBadgeOrHtmlLine(line)) continue;
    return line;
  }
  return undefined;
}
