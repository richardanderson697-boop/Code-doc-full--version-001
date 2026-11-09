// Regex-based deterministic code scan. Pure function, no I/O: feeds
// fact-based clues (endpoints, TODOs, stubs, hardcoded ports) into the
// cold-audit evidence sheet so the LLM layer starts from ground truth.
//
// Several patterns here contain adjacent `\s*` groups, which backtrack
// superlinearly. `/function\s*\w*\s*\(\s*\)\s*\{\s*\}/` against a line of
// "function" followed by whitespace measured 82ms at 16KB, 1.3s at 64KB and
// 11.9s at 128KB, all of it blocking the event loop. The caps below bound
// that, and are checked per line because line length is what drives the cost.
// A skipped line is still counted so callers can see coverage was reduced.
export const MAX_SCAN_BYTES = 256 * 1024;
export const MAX_SCAN_LINE_CHARS = 20000;

export interface ScanIssue {
  lines: string;
  code: string;
}

/**
 * One interactive element that promises an action but has no wiring in
 * the code — no onClick, no href, no asChild link, not a submit button in
 * a form. Dead by construction: clicking it cannot do anything. The
 * Automate-AI pricing page is the motivating case (three "Get Started"
 * buttons, zero handlers, 2026-11-07).
 */
export interface DeadActionIssue {
  lines: string;
  code: string; // opening tag, trimmed, capped
  label: string; // visible text, or "icon-only button"
  paymentRelated: boolean;
}

export interface DeterministicAnalysis {
  endpointCount: number;
  fetchCount: number;
  todoCount: number;
  commentedSchedulersCount: number;
  stubCount: number;
  hardcodedPortCount: number;
  usesProcessEnvPort: boolean;
  anyCount: number;
  testCount: number;
  deadActionCount: number;
  mockedPaymentCount: number;
  mockedNotificationCount: number;
  deliveryClaimCount: number;
  fabricatedStatusCount: number;
  // Coverage was reduced: the input was longer than the byte cap, or some
  // lines were longer than the line cap. Reported rather than hidden.
  truncated: boolean;
  skippedLines: number;

  endpoints: ScanIssue[];
  fetchCalls: ScanIssue[];
  todos: ScanIssue[];
  commentedSchedulers: ScanIssue[];
  stubs: ScanIssue[];
  hardcodedPorts: ScanIssue[];
  anyUsages: ScanIssue[];
  tests: ScanIssue[];
  deadActions: DeadActionIssue[];
  mockedPayments: ScanIssue[];
  mockedNotifications: ScanIssue[];
  deliveryClaims: ScanIssue[];
  fabricatedStatus: FabricatedStatusIssue[];
}

// ---------------------------------------------------------------------------
// Dead action elements (Rule 1) + mocked payments (Rule 2).
// Spec: finalread-dead-action-mocked-payment-detection-spec.md.
// ---------------------------------------------------------------------------

const JSX_FILE = /\.(tsx|jsx)$/i;
// A button/link label that promises a purchase, or a pricing/checkout page
// — either makes the dead element payment-related.
const PAYMENT_LABEL =
  /\b(buy|checkout|pay|subscribe|upgrade|purchase|get\s+started|start\s+(free\s+)?trial)\b/i;
const PAYMENT_PATH = /(pricing|checkout|billing|subscribe|payment)/i;
const API_ROUTE_FILE =
  /(^|\/)app\/api\/.+\/route\.(ts|tsx|js|jsx)$|(^|\/)pages\/api\/.+\.(ts|tsx|js|jsx)$|(^|\/)server\/routes\/.+\.(ts|js)$|(^|\/)routes\/.+\.(ts|js)$/;
// A payment provider actually being used: an import/require of the
// provider module, a `new Provider(` construction, or a member call
// (`stripe.charges.create`). A bare word mention (a comment, a label)
// does not count — that would suppress the flag on a guess. The reverse
// error (a comment containing `stripe.charges.create` suppressing a real
// flag) is the safe direction: a missed flag, never a false one.
const PAYMENT_PROVIDER_USE =
  /\bimport\s+[^;]*\b(stripe|paypal|square|paddle|lemonsqueezy|braintree)\b|\brequire\s*\([^)]*\b(stripe|paypal|square|paddle|lemonsqueezy|braintree)\b|\bnew\s+(Stripe|PayPal|Square)\s*\(|\b(stripe|paypal|square|paddle|lemonsqueezy|braintree)\s*\.\s*\w+/i;
const COMPLETED_STATUS = /\bstatus\s*:\s*['"](completed|paid|success)['"]/;

// ---------------------------------------------------------------------------
// Mocked notifications (Rule A) + UI delivery claims (Rule C).
// Spec: finalread-mocked-delivery-detection-spec.md. The Whistle-stop
// cleaning app is the motivating case (2026-11-07): the success screen
// tells the customer their photos "have been sent directly to our
// administrator", while the server only writes NotificationLogs with
// status 'Delivered' into an in-memory array — no email/SMS provider
// anywhere in the repo.
// ---------------------------------------------------------------------------

// A delivery provider actually being used: an import/require of the
// provider module, a `new Provider(` construction, or a member call
// (`transporter.sendMail`, `twilio.messages.create`). Same shape as
// PAYMENT_PROVIDER_USE. Exported: the score layer applies this repo-wide
// (a provider usually lives in a shared module, unlike a checkout route),
// so the scan emits candidates and the score layer filters them.
export const DELIVERY_PROVIDER_USE =
  /\bimport\s+[^;]*\b(nodemailer|smtp|resend|sendgrid|mailgun|postmark|ses|twilio|vonage|nexmo|firebase-admin|web-push)\b|\brequire\s*\([^)]*\b(nodemailer|smtp|resend|sendgrid|mailgun|postmark|ses|twilio|vonage|nexmo|firebase-admin|web-push)\b|\bnew\s+(Twilio|Vonage|SES)\s*\(|\b(nodemailer|transporter|resend|sendgrid|mailgun|postmark|ses|twilio|vonage|nexmo|messaging)\s*\.\s*\w+/i;
const DELIVERED_STATUS = /\bstatus\s*:\s*['"](Delivered|Sent|delivered|sent)['"]/;
const NOTIFICATION_CHANNEL = /\bchannel\s*:\s*['"](EMAIL|SMS|PUSH|email|sms|push)['"]/i;
const NOTIFICATION_TYPE = /\w*(Notification|Notif)\w*/;

// A notification recorded as delivered: a status assignment inside a
// notification/message object — the surrounding literal must mention a
// delivery channel or a notification type name. The channel/type context
// is mandatory: a bare `status: 'Delivered'` on an order or shipment
// object is a business state, not a delivery claim, and must NOT fire.
// Candidates only: the score layer drops them when any file in the repo
// uses a delivery provider. No file restriction — a notification log can
// live in a route, a service, or a store.
// Two guards against noise, both learned from the Whistle-stop run
// (2026-11-07): a type union (`status: 'Sent' | 'Delivered'` in an
// interface) is a declaration, not a recorded delivery — skipped by the
// pipe check below; seed/fixture/sample data files describe example rows,
// not app behavior — skipped by path.
const SEED_DATA_FILE = /(^|\/)(seed|sample|mock|fixture|initialdata)/i;
function findMockedNotifications(code: string, filePath: string): ScanIssue[] {
  if (SEED_DATA_FILE.test(filePath)) return [];
  const out: ScanIssue[] = [];
  const lines = code.split("\n");
  lines.forEach((raw, idx) => {
    if (raw.length > MAX_SCAN_LINE_CHARS) return;
    const line = raw.trim();
    if (!DELIVERED_STATUS.test(line)) return;
    // A union type (`status: 'Sent' | 'Delivered'`) is a declaration,
    // not a status being recorded — the pipe after the quoted value
    // gives it away.
    if (/['"]\s*\|/.test(line)) return;
    // The object literal holding the status: up to 20 lines back covers
    // the Whistle-stop shape (channel ~4 lines above the status line).
    // A comment mentioning "notification" nearby can create a candidate;
    // the provider filter and the unverified disposition absorb that.
    const window = lines.slice(Math.max(0, idx - 20), idx + 1).join("\n");
    if (!NOTIFICATION_CHANNEL.test(window) && !NOTIFICATION_TYPE.test(window)) return;
    out.push({ lines: String(idx + 1), code: line.slice(0, 200) });
  });
  return out;
}

// UI copy asserting a completed delivery — exact past-tense phrases only.
// A future promise ("we'll send your quote") does NOT fire: a phrase
// preceded by a future auxiliary (will/shall/'ll + optional be) is
// skipped. Candidates only: the score layer drops them when any file in
// the repo uses a delivery provider. UI copy only — JSX/TSX files — so a
// server response message is not a claim under this rule.
const DELIVERY_CLAIM_PHRASES = [
  "has been sent",
  "have been sent",
  "sent directly to",
  "sent to our administrator",
  "notification dispatched",
  "dispatched to",
];
const FUTURE_AUX_BEFORE = /\b(will|shall|'ll)\s+(be\s+)?$/i;

function findDeliveryClaims(code: string, filePath: string): ScanIssue[] {
  if (!JSX_FILE.test(filePath)) return [];
  const out: ScanIssue[] = [];
  const lines = code.split("\n");
  lines.forEach((raw, idx) => {
    if (raw.length > MAX_SCAN_LINE_CHARS) return;
    const line = raw.trim();
    const lower = line.toLowerCase();
    for (const phrase of DELIVERY_CLAIM_PHRASES) {
      const at = lower.indexOf(phrase);
      if (at < 0) continue;
      // Future-tense guard: "will be sent directly to your door" is a
      // promise about the future, not a claim of a completed delivery.
      const before = lower.slice(Math.max(0, at - 25), at);
      if (FUTURE_AUX_BEFORE.test(before)) continue;
      // The issue's code starts at the claim itself, so the finding's
      // title and evidence lead with the asserted delivery, not with
      // whatever text precedes it on the line.
      out.push({ lines: String(idx + 1), code: line.slice(at, at + 200) });
      break; // one issue per line, even if two phrases match it
    }
  });
  return out;
}

// Scan one JSX opening tag starting at `start` (`<Button`, `<button`,
// `<a`): the tag ends at the first `>` at brace depth 0 outside quotes.
// Bounded (2000 chars) so a malformed tag cannot run the scanner.
function parseJsxTag(code: string, start: number): { end: number; tagText: string } | null {
  const CAP = 2000;
  let j = start + 1;
  let depth = 0;
  let q: string | null = null;
  while (j < code.length && j - start <= CAP) {
    const c = code[j];
    if (q) {
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === q) q = null;
      j++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) {
      return { end: j, tagText: code.slice(start, j + 1) };
    }
    j++;
  }
  return null;
}

// True when the last opening tag of this kind in `text` comes after the
// last closing tag — i.e. the element is still open and wraps whatever
// follows. Window is the caller's slice (400 chars), which covers the
// real-world shape (a Link immediately wrapping a Button); a Link opened
// far above is a documented miss, not a silent false positive.
function lastOpenBeforeClose(text: string, openRe: RegExp, closeTag: string): boolean {
  let lastOpen = -1;
  let m: RegExpExecArray | null;
  openRe.lastIndex = 0;
  while ((m = openRe.exec(text)) !== null) lastOpen = m.index;
  const lastClose = text.lastIndexOf(closeTag);
  return lastOpen !== -1 && lastOpen > lastClose;
}

function findDeadActions(code: string, filePath: string): DeadActionIssue[] {
  if (!JSX_FILE.test(filePath)) return [];
  const paymentPage = PAYMENT_PATH.test(filePath);
  const out: DeadActionIssue[] = [];
  const n = code.length;
  let i = 0;
  let line = 1;
  // Scanner state: code, or inside a comment/string. Template literals
  // are treated as strings whole, so a `<Button` inside a `${...}`
  // interpolation is missed — safe direction, documented.
  let state: "code" | "lineComment" | "blockComment" | "string" = "code";
  let quote = "";

  const tagNameAt = (pos: number): string | null => {
    if (code[pos] !== "<") return null;
    for (const name of ["Button", "button", "a"]) {
      if (code.startsWith(name, pos + 1)) {
        const after = code[pos + 1 + name.length] ?? "";
        if (after === "" || /[\s>/]/.test(after)) return name;
      }
    }
    return null;
  };

  while (i < n) {
    const ch = code[i];
    if (state === "lineComment") {
      if (ch === "\n") {
        state = "code";
        line++;
      }
      i++;
      continue;
    }
    if (state === "blockComment") {
      if (ch === "\n") line++;
      if (ch === "*" && code[i + 1] === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (state === "string") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") line++;
      if (ch === quote) state = "code";
      i++;
      continue;
    }
    // state === "code"
    if (ch === "/" && code[i + 1] === "/") {
      state = "lineComment";
      i += 2;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      state = "blockComment";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      state = "string";
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    const name = tagNameAt(i);
    if (!name) {
      i++;
      continue;
    }
    const tagStart = i;
    const tagLine = line;
    const parsed = parseJsxTag(code, i);
    if (!parsed) {
      i++;
      continue;
    }
    for (let k = i; k <= parsed.end; k++) if (code[k] === "\n") line++;
    i = parsed.end + 1;
    const tagText = parsed.tagText;

    // A disabled button promises nothing — excluded outright.
    if (/\bdisabled\b/.test(tagText)) continue;
    // A props spread ({...props}, {...rest}) forwards whatever the caller
    // passed — including onClick — so the element is wired by the caller,
    // not dead. This is how shared components (shadcn Button renders
    // `<Comp ... {...props} />`) stay out of the results.
    const hasHandler =
      /\bonClick\s*=/.test(tagText) ||
      /\bhref\s*=/.test(tagText) ||
      /\bonSubmit\s*=/.test(tagText) ||
      /\{\.\.\./.test(tagText);
    if (hasHandler) continue;

    // Children (bounded window): the label, and the asChild link check.
    const closeTag = `</${name}>`;
    const closeIdx = code.indexOf(closeTag, parsed.end + 1);
    const children =
      closeIdx !== -1 && closeIdx - (parsed.end + 1) <= 2000
        ? code.slice(parsed.end + 1, closeIdx)
        : "";
    const label = children
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);

    const before = code.slice(Math.max(0, tagStart - 400), tagStart);
    const wrappedInLink =
      lastOpenBeforeClose(before, /<Link\b[^>]*\bhref\s*=/g, "</Link>") ||
      lastOpenBeforeClose(before, /<a\b[^>]*\bhref\s*=/g, "</a>");
    if (wrappedInLink) continue;
    const asChildWired =
      /\basChild\b/.test(tagText) && /<(Link|a)\b[^>]*\bhref\s*=/.test(children);
    if (asChildWired) continue;
    if (
      /\btype\s*=\s*["']submit["']/.test(tagText) &&
      lastOpenBeforeClose(before, /<form\b[^>]*>/g, "</form>")
    ) {
      continue;
    }

    out.push({
      lines: String(tagLine),
      code: tagText.replace(/\s+/g, " ").trim().slice(0, 120),
      label: label || "icon-only button",
      paymentRelated: PAYMENT_LABEL.test(label) || paymentPage,
    });
  }
  return out;
}

function findMockedPayments(code: string, filePath: string): ScanIssue[] {
  if (!API_ROUTE_FILE.test(filePath)) return [];
  if (!/(checkout|payment|purchase|subscribe|billing)/i.test(filePath)) return [];
  // A provider call anywhere in the file means payment is taken here —
  // the route is not mocked. Checked first so the status lines below
  // only fire on genuinely provider-free routes.
  if (PAYMENT_PROVIDER_USE.test(code)) return [];
  const out: ScanIssue[] = [];
  const lines = code.split("\n");
  lines.forEach((raw, idx) => {
    if (raw.length > MAX_SCAN_LINE_CHARS) return;
    const line = raw.trim();
    if (COMPLETED_STATUS.test(line)) {
      out.push({ lines: String(idx + 1), code: line.slice(0, 200) });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Fabricated status responses (README-truth spec §4). A route handler
// returns a res.json/res.send object whose values are all literals, with a
// key matching /status|health/i carrying a status word ('Healthy',
// 'ok', 'connected') — constants presented as live metrics, with no
// query or check behind them. The RentStream pattern:
//   res.json({ activeUsers: 1452, bookingsToday: 89,
//              systemHealth: 'Healthy', databaseStatus: 'Connected' });
// The numbers are invented; the strings are constants. A buyer reading
// that dashboard believes the system is live.
//
// The response is NOT literal-checked when the file is a seed/fixture/
// sample/mock or a test — those are data, not claims — and a bare
// liveness route (/health, /ping, ...) is excluded: answering "up" is
// what it is for. What is NOT covered in v1: counts-only responses
// with no status signal (a numeric body with no status word is not a
// live-metrics claim; see spec §4 "Open question 3"), and a status
// string computed from real state — the literal-only check lets it
// through, which is the right direction (it is at least computed).
// ---------------------------------------------------------------------------

export interface FabricatedStatusIssue {
  /** "line" or "start-end". */
  lines: string;
  code: string;
  /** e.g. "GET /api/admin/metrics" when the route registration was found. */
  route?: string;
  /** The exact status signal found, e.g. `systemHealth: 'Healthy'`. */
  statusSignal: string;
}

// A status key carrying one of these words is presented as a live state,
// not a count or an id.
const STATUS_WORDS = ["healthy", "ok", "connected", "operational", "online", "up", "live"];
const STATUS_KEY = /status|health/i;
const STATUS_WORD = new RegExp(`^['"\`](?:${STATUS_WORDS.join("|")})['"\`]$`, "i");

// Bare liveness endpoints answer "up" by design; a constant there is not
// a live-metrics claim.
const LIVENESS_PATHS = new Set(["/health", "/healthz", "/ready", "/live", "/ping"]);

// A res.json/res.send with an inline object literal as its argument.
const RESPONSE_CALL =
  /(?:\bres|\bresponse)\s*\.\s*(?:json|send)\s*\(\s*(\{)/g;
const ROUTE_REGISTRATION =
  /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const TEST_FILE = /\.(?:test|spec)\.[jt]sx?$/i;

// Brace-match from the opening brace at `open`, returning the index just
// past the matching close. Strings, template literals (with ${...}
// interpolation) and nested brackets are honoured. Returns -1 when the
// object never closes — the file is truncated and nothing may be said.
function matchObjectLiteral(text: string, open: number): number {
  const stack: string[] = [];
  let state: "code" | "sq" | "dq" | "tq" = "code";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (state === "sq") {
      if (ch === "\\") i++;
      else if (ch === "'") state = "code";
      continue;
    }
    if (state === "dq") {
      if (ch === "\\") i++;
      else if (ch === '"') state = "code";
      continue;
    }
    if (state === "tq") {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "`") {
        state = "code";
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        stack.push("${");
        state = "code";
        i++;
      }
      continue;
    }
    if (ch === "'") state = "sq";
    else if (ch === '"') state = "dq";
    else if (ch === "`") state = "tq";
    else if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      const kind = stack.pop();
      if (kind === "${") {
        state = "tq";
        continue;
      }
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

// Split the interior of an object literal on its top-level commas,
// honouring strings, template literals and nested brackets. Returns
// null on unbalanced input.
function splitTopLevelCommas(s: string): string[] | null {
  const parts: string[] = [];
  const stack: string[] = [];
  let state: "code" | "sq" | "dq" | "tq" = "code";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (state === "sq") {
      if (ch === "\\") i++;
      else if (ch === "'") state = "code";
      continue;
    }
    if (state === "dq") {
      if (ch === "\\") i++;
      else if (ch === '"') state = "code";
      continue;
    }
    if (state === "tq") {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "`") {
        state = "code";
        continue;
      }
      if (ch === "$" && s[i + 1] === "{") {
        stack.push("${");
        state = "code";
        i++;
      }
      continue;
    }
    if (ch === "'") state = "sq";
    else if (ch === '"') state = "dq";
    else if (ch === "`") state = "tq";
    else if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      const kind = stack.pop();
      if (kind === undefined) return null;
      if (kind === "${") state = "tq";
    } else if (ch === "," && stack.length === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (state !== "code" || stack.length !== 0) return null;
  parts.push(s.slice(start));
  return parts;
}

// The first colon at brace depth 0, outside strings — the key/value
// separator of one top-level field. -1 when the field has no colon
// (a spread or a shorthand with no value of its own).
function firstTopLevelColon(s: string): number {
  const stack: string[] = [];
  let state: "code" | "sq" | "dq" | "tq" = "code";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (state === "sq") {
      if (ch === "\\") i++;
      else if (ch === "'") state = "code";
      continue;
    }
    if (state === "dq") {
      if (ch === "\\") i++;
      else if (ch === '"') state = "code";
      continue;
    }
    if (state === "tq") {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "`") {
        state = "code";
        continue;
      }
      if (ch === "$" && s[i + 1] === "{") {
        stack.push("${");
        state = "code";
        i++;
      }
      continue;
    }
    if (ch === "'") state = "sq";
    else if (ch === '"') state = "dq";
    else if (ch === "`") state = "tq";
    else if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      const kind = stack.pop();
      if (kind === "${") state = "tq";
    } else if (ch === ":" && stack.length === 0) return i;
  }
  return -1;
}

// A value that is a constant, not a computation: a number, a quoted
// string, a boolean, null. Everything else — an identifier, a member
// access, a call, a template literal (it interpolates something), a
// nested object or array — is at least computed, so the response is not
// fabricated by this rule.
function isLiteralValue(value: string): boolean {
  const v = value.trim();
  if (v === "true" || v === "false" || v === "null") return true;
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(v)) return true;
  const m = /^(['"`])(.*)\1$/.exec(v);
  // A template literal interpolates — computed, not constant.
  if (m && m[1] === "`") return false;
  return m !== null;
}

// Whether the `/` at `i` starts a regex literal rather than division.
// The previous significant token decides: after an operator, an opening
// bracket, a comma, a colon, a semicolon, a `}` (block close), or a
// return-like keyword, a `/` opens a regex; after an operand (identifier,
// number, string end, `)`, `]`) it divides. The standard heuristic —
// without it, a regex containing quotes (e.g. /^['"`]|['"`]$/g)
// toggles the string states and the stripper desyncs for the rest of
// the file, blanking real code as "string" and missing real comments.
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "case", "delete", "void", "in", "of",
  "instanceof", "new", "yield", "await", "else", "do",
]);

function isRegexStart(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  const prev = text[j];
  if ("(,=:[!&|?{};*+-/%^~<>".includes(prev)) return true;
  if (prev === "}") return true;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k--;
    return REGEX_KEYWORDS.has(text.slice(k + 1, j + 1));
  }
  return false;
}

// The index just past a regex literal starting at `i` (text[i] === '/'),
// flags included. Escapes and [...] classes are honoured, so a `/`
// inside a class never ends the regex. Bails at a newline — an
// unterminated regex must not swallow the rest of the file.
function skipRegex(text: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      return j;
    } else if (c === "\n") return j;
    j++;
  }
  return j;
}
// newline, so a commented-out res.json — a doc example, a disabled
// handler — never reads as a live endpoint. Strings and template
// literals are left intact (a "//" inside a string is not a comment);
// ${...} interpolation is scanned as code, so a comment inside one is
// still blanked. The returned string is the same length as the input,
// so every index and line number found here maps 1:1 to the original.
function stripCommentsToSpaces(text: string): string {
  const out = text.split("");
  let state: "code" | "sq" | "dq" | "tq" | "line" | "block" = "code";
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === "line") {
      if (ch === "\n") state = "code";
      else out[i] = " ";
      continue;
    }
    if (state === "block") {
      if (ch === "*" && text[i + 1] === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i++;
        state = "code";
      } else if (ch !== "\n") out[i] = " ";
      continue;
    }
    if (state === "sq") {
      if (ch === "\\") i++;
      else if (ch === "'") state = "code";
      continue;
    }
    if (state === "dq") {
      if (ch === "\\") i++;
      else if (ch === '"') state = "code";
      continue;
    }
    if (state === "tq") {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "`") {
        state = "code";
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        stack.push("${");
        state = "code";
        i++;
      }
      continue;
    }
    if (ch === "'") state = "sq";
    else if (ch === '"') state = "dq";
    else if (ch === "`") state = "tq";
    else if (ch === "/" && text[i + 1] === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      i++;
      state = "line";
    } else if (ch === "/" && text[i + 1] === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i++;
      state = "block";
    } else if (ch === "/" && isRegexStart(text, i)) {
      // A regex literal is code, not a comment — but its contents must
      // not toggle the string states (a quote inside /['"]/ would
      // desync the stripper for the rest of the file). Skip it whole.
      i = skipRegex(text, i) - 1;
    } else if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      const kind = stack.pop();
      if (kind === "${") state = "tq";
    }
  }
  return out.join("");
}

// The 1-based line number of a character index in the file.
function lineOf(text: string, index: number): string {
  return String(text.slice(0, index).split("\n").length);
}

export function findFabricatedStatus(code: string, filePath: string): FabricatedStatusIssue[] {
  if (SEED_DATA_FILE.test(filePath) || TEST_FILE.test(filePath)) return [];

  // Scan comment-stripped text: a commented-out res.json is a doc
  // example or a disabled handler, not a live endpoint. Positions are
  // preserved, so indices and line numbers map 1:1 to the original;
  // the evidence snippet is sliced from the original text.
  const text = stripCommentsToSpaces(code);

  // The route each response call belongs to: the nearest registration
  // before it. A response on a bare liveness route is not a claim.
  const routes: { index: number; route: string }[] = [];
  ROUTE_REGISTRATION.lastIndex = 0;
  let reg: RegExpExecArray | null;
  while ((reg = ROUTE_REGISTRATION.exec(text)) !== null) {
    routes.push({ index: reg.index, route: `${reg[1].toUpperCase()} ${reg[2]}` });
  }
  const routeAt = (index: number): string | undefined => {
    let found: string | undefined;
    for (const r of routes) {
      if (r.index > index) break;
      found = r.route;
    }
    return found;
  };
  const routePathOf = (route: string | undefined): string | undefined =>
    route ? route.split(" ")[1] : undefined;

  const out: FabricatedStatusIssue[] = [];
  RESPONSE_CALL.lastIndex = 0;
  let call: RegExpExecArray | null;
  while ((call = RESPONSE_CALL.exec(text)) !== null) {
    const braceIndex = text.indexOf("{", call.index);
    const end = matchObjectLiteral(text, braceIndex);
    if (end === -1) continue;
    const fields = splitTopLevelCommas(text.slice(braceIndex + 1, end - 1));
    if (!fields || fields.length < 2) continue;

    // Every field must be a key with a literal value. A spread, a
    // shorthand, or a computed value means the response is at least
    // partly computed — not fabricated by this rule.
    const parsed: { key: string; value: string }[] = [];
    let allLiteral = true;
    for (const field of fields) {
      const trimmed = field.trim();
      if (!trimmed) continue;
      const colon = firstTopLevelColon(trimmed);
      if (colon === -1) {
        allLiteral = false;
        break;
      }
      const key = trimmed.slice(0, colon).trim().replace(/^['"`]|['"`]$/g, "");
      const value = trimmed.slice(colon + 1);
      if (!isLiteralValue(value)) {
        allLiteral = false;
        break;
      }
      parsed.push({ key, value });
    }
    if (!allLiteral || parsed.length < 2) continue;

    const signal = parsed.find(
      (f) => STATUS_KEY.test(f.key) && STATUS_WORD.test(f.value.trim())
    );
    if (!signal) continue;

    const route = routeAt(call.index);
    const routePath = routePathOf(route);
    if (routePath && LIVENESS_PATHS.has(routePath)) continue;

    out.push({
      lines: lineOf(text, call.index),
      code: code.slice(braceIndex, Math.min(end, braceIndex + 120)).replace(/\s+/g, " ").trim(),
      route,
      statusSignal: `${signal.key}: ${signal.value.trim()}`,
    });
  }
  return out;
}

export function runDeterministicScan(code: string, filePath = ""): DeterministicAnalysis {
  // Truncate before splitting: past the byte cap the extra input adds no
  // useful evidence and only costs backtracking time.
  const bounded = code.length > MAX_SCAN_BYTES ? code.slice(0, MAX_SCAN_BYTES) : code;
  const lines = bounded.split("\n");
  let skippedLines = 0;
  const endpoints: ScanIssue[] = [];
  const fetchCalls: ScanIssue[] = [];
  const todos: ScanIssue[] = [];
  const commentedSchedulers: ScanIssue[] = [];
  const stubs: ScanIssue[] = [];
  const hardcodedPorts: ScanIssue[] = [];
  const anyUsages: ScanIssue[] = [];
  const tests: ScanIssue[] = [];

  let usesProcessEnvPort = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Skip before trim(): an enormous line is exactly the input these regexes
    // backtrack on, and trimming it first would itself scan the whole string.
    if (rawLine.length > MAX_SCAN_LINE_CHARS) {
      skippedLines++;
      continue;
    }
    const line = rawLine.trim();
    const lineNum = i + 1;

    if (!line) continue;

    // Detect process.env.PORT
    if (line.includes("process.env.PORT") || line.includes("ENV.PORT")) {
      usesProcessEnvPort = true;
    }

    // 1. Endpoints
    const endpointRegex = /\b(app|router)\.(get|post|put|delete|patch|use)\s*\(\s*['"`]/i;
    if (endpointRegex.test(line)) {
      endpoints.push({ lines: String(lineNum), code: line });
    }

    // 2. Fetch/Axios calls
    const fetchRegex = /\b(fetch|axios|axios\.(get|post|put|delete|patch))\s*\(/;
    if (fetchRegex.test(line) && !line.startsWith("//") && !line.startsWith("*")) {
      fetchCalls.push({ lines: String(lineNum), code: line });
    }

    // 3. TODOs / FIXMEs / BUGs
    const isComment = line.startsWith("//") || line.startsWith("/*") || line.startsWith("*");
    // Test files are fixtures, not unfinished code — a marker inside a
    // template-string fake route in a test file is the test doing its job.
    // (Same principle as the section-5 test-file exemption below.)
    const isTestFile = /(^|\/)(__tests__|__test__|tests?|testdata|cypress|e2e|playwright|__mocks__|mocks?)\/|\.(test|spec)\.[jt]sx?$/i.test(filePath);
    // The marker must LEAD the comment (Oct 28 stub-detector spec):
    // a header like "Add Todo Evidence" is code about markers, not a
    // marker, and prose that happens to contain the word bug mid-sentence
    // is not a marker either.
    const commentText = line.replace(/^(\/\/|\/\*|\*)\s*/, "");
    if (isComment && !isTestFile && /^(TODO|FIXME|BUG)\b/i.test(commentText)) {
      todos.push({ lines: String(lineNum), code: line });
    }

    // 4. Commented-out schedulers / timers
    if (isComment && /\b(setInterval|setTimeout|cron\.schedule|scheduleJob)\b/.test(line)) {
      commentedSchedulers.push({ lines: String(lineNum), code: line });
    }

    // 5. Stubs / Mocks
    // A file whose whole job is mock/fixture/seed data is not "unfinished"
    // because it declares const MOCK_*: flagging it is pure noise.
    // NOTE: bare keywords ("mock", "simulated", ...) in *comments* are not
    // stubs — a comment describing simulated data is documentation, not
    // unfinished code. Only an explicit TODO: implement marker in a comment
    // counts as a stub signal, and the marker must lead the comment — a
    // mid-sentence mention does not count.
    // NOTE: mock declarations in *test* files are fixtures, not unfinished
    // code — `const mockBlueprint = {...}` in orchestration.test.ts is the
    // test doing its job.
    const isMockDataFile = /(^|\/)(mock|mocks|fixture|fixtures|seed|seeds|stub|stubs)[^/]*\.(ts|tsx|js|jsx)$/i.test(filePath);
    // Trailing word boundary (Oct 28 stub-detector spec): `const tempDeck`,
    // `const temperature`, and `const mocked` are real identifiers, not
    // temporary placeholders — only the exact two-word declaration
    // counts. (isTestFile is defined above section 3; reused here.)
    // Disclosed extension, found during the build: the named fixture list
    // below matched its own definition line (the line lists mockUsers and
    // friends as regex source), so the list is anchored to a declaration
    // keyword too — a bare use of a fixture name is not a declaration.
    const isMockDeclaration = !isMockDataFile && !isTestFile && (/\b(const|let|var)\s+(mockData|mockUsers|mockTodos|mockEvents|tempData)\b/i.test(line) || /\bconst\s+mock\b/i.test(line) || /\bconst\s+temp\b/i.test(line));
    const isEmptyFunction = /=>\s*\{\s*\}/.test(line) || /function\s*\w*\s*\(\s*\)\s*\{\s*\}/.test(line);
    // Lead-anchor (Oct 28 stub-detector spec): the marker must lead the
    // comment. A definitional comment that mentions the marker
    // mid-sentence does not count.
    const isTodoImplement = /^TODO:\s*implement/i.test(commentText);

    if ((isComment && isTodoImplement) || isMockDeclaration || (isEmptyFunction && !line.includes("export") && line.toLowerCase().includes("handler"))) {
      stubs.push({ lines: String(lineNum), code: line });
    }

    // 6. Hardcoded ports
    const hardcodedPortRegex = /\b(listen\(\s*\d{4,5})|(\bPORT\s*=\s*\d{4,5})\b/i;
    if (hardcodedPortRegex.test(line) && !line.includes("process.env.PORT")) {
      hardcodedPorts.push({ lines: String(lineNum), code: line });
    }

    // 7. TS any types
    const anyRegex = /(:\s*any\b)|(<\s*any\s*>)|(\bas\s+any\b)/;
    if (anyRegex.test(line) && !isComment && !line.includes("Schema") && !line.includes("schema")) {
      anyUsages.push({ lines: String(lineNum), code: line });
    }

    // 8. Test assertions
    const testRegex = /\b(describe|test|it|expect)\s*\(/;
    if (testRegex.test(line) && !isComment) {
      tests.push({ lines: String(lineNum), code: line });
    }
  }

  // Rule 1 + Rule 2 run over the whole file (element context spans
  // lines), not in the per-line loop above. Rules A + C likewise.
  const deadActions = findDeadActions(bounded, filePath);
  const mockedPayments = findMockedPayments(bounded, filePath);
  const mockedNotifications = findMockedNotifications(bounded, filePath);
  const deliveryClaims = findDeliveryClaims(bounded, filePath);
  const fabricatedStatus = findFabricatedStatus(bounded, filePath);

  return {
    truncated: bounded.length < code.length,
    skippedLines,
    endpointCount: endpoints.length,
    fetchCount: fetchCalls.length,
    todoCount: todos.length,
    commentedSchedulersCount: commentedSchedulers.length,
    stubCount: stubs.length,
    hardcodedPortCount: hardcodedPorts.length,
    usesProcessEnvPort,
    anyCount: anyUsages.length,
    testCount: tests.length,
    deadActionCount: deadActions.length,
    mockedPaymentCount: mockedPayments.length,
    mockedNotificationCount: mockedNotifications.length,
    deliveryClaimCount: deliveryClaims.length,
    fabricatedStatusCount: fabricatedStatus.length,
    endpoints,
    fetchCalls,
    todos,
    commentedSchedulers,
    stubs,
    hardcodedPorts,
    anyUsages,
    tests,
    deadActions,
    mockedPayments,
    mockedNotifications,
    deliveryClaims,
    fabricatedStatus,
  };
}
