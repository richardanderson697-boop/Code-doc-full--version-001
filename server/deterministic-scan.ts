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
    if (isComment && /\b(TODO|FIXME|BUG)\b/i.test(line)) {
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
    // counts as a stub signal.
    // NOTE: mock declarations in *test* files are fixtures, not unfinished
    // code — `const mockBlueprint = {...}` in orchestration.test.ts is the
    // test doing its job.
    const isMockDataFile = /(^|\/)(mock|mocks|fixture|fixtures|seed|seeds|stub|stubs)[^/]*\.(ts|tsx|js|jsx)$/i.test(filePath);
    const isTestFile = /(^|\/)(__tests__|__test__|tests?|testdata|cypress|e2e|playwright|__mocks__|mocks?)\/|\.(test|spec)\.[jt]sx?$/i.test(filePath);
    const isMockDeclaration = !isMockDataFile && !isTestFile && (/\b(mockData|mockUsers|mockTodos|mockEvents|tempData)\b/i.test(line) || /\bconst\s+mock/i.test(line) || /\bconst\s+temp/i.test(line));
    const isEmptyFunction = /=>\s*\{\s*\}/.test(line) || /function\s*\w*\s*\(\s*\)\s*\{\s*\}/.test(line);
    const isTodoImplement = /TODO:\s*implement/i.test(line);

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
  };
}
