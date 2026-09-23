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
}

export function runDeterministicScan(code: string): DeterministicAnalysis {
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
    const stubKeywords = /\b(stub|mock|placeholder|temporary|simulated|hardcoded)\b/i;
    const isMockDeclaration = /\b(mockData|mockUsers|mockTodos|mockEvents|tempData)\b/i.test(line) || /\bconst\s+mock/i.test(line) || /\bconst\s+temp/i.test(line);
    const isEmptyFunction = /=>\s*\{\s*\}/.test(line) || /function\s*\w*\s*\(\s*\)\s*\{\s*\}/.test(line);
    const isTodoImplement = /TODO:\s*implement/i.test(line);
    
    if ((isComment && (stubKeywords.test(line) || isTodoImplement)) || isMockDeclaration || (isEmptyFunction && !line.includes("export") && line.toLowerCase().includes("handler"))) {
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
    endpoints,
    fetchCalls,
    todos,
    commentedSchedulers,
    stubs,
    hardcodedPorts,
    anyUsages,
    tests
  };
}
