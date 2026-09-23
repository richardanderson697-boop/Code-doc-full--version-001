// The adapter's defensive branches are unreachable from a real scan: the
// engine never emits an unknown severity, a non-array OWASP mapping, or a
// probe failure on our corpus. Tests written against the real engine therefore
// asserted the adapter's own output shape and could not fail. These drive a
// fake engine so the branches actually run.
import { describe, it, expect } from "vitest";
import { runPreFlightScan, formatFindingsForPrompt } from "../server/preflight-scan";
import { isScanIncomplete } from "../shared/preflight-types";

const FILES = [{ path: "src/a.ts", content: "export const a = 1;\n" }];
const fake = (result: any) => () => result;

describe("severity coercion", () => {
  it("coerces an unknown severity to info and keeps the original visible", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [{ severity: "blocker", probe: "P", title: "RCE", file: "src/a.ts", line: 4 }],
        probeFailures: [],
        score: 10,
      })
    );
    expect(r.findings[0].severity).toBe("info");
    expect(r.findings[0].originalSeverity).toBe("blocker");
  });

  it("records a missing severity rather than pretending it was info", () => {
    const r = runPreFlightScan(
      FILES,
      fake({ findings: [{ probe: "P", title: "no severity" }], probeFailures: [], score: 0 })
    );
    expect(r.findings[0].severity).toBe("info");
    expect(r.findings[0].originalSeverity).toBe("(missing)");
  });

  it("leaves a known severity untouched", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [{ severity: "critical", probe: "P", title: "t", file: "f", line: 1 }],
        probeFailures: [],
        score: 0,
      })
    );
    expect(r.findings[0].severity).toBe("critical");
    expect(r.findings[0].originalSeverity).toBeUndefined();
  });

  it("sorts coerced findings into their new position", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [
          { severity: "weird", probe: "P", title: "coerced to info", file: "f", line: 1 },
          { severity: "critical", probe: "P", title: "real critical", file: "f", line: 2 },
        ],
        probeFailures: [],
        score: 0,
      })
    );
    expect(r.findings.map((f) => f.title)).toEqual(["real critical", "coerced to info"]);
  });
});

describe("OWASP normalization", () => {
  it("wraps a bare string mapping in an array", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [{ severity: "high", probe: "P", title: "t", file: "f", line: 1, owasp: "A02" }],
        probeFailures: [],
        score: 0,
      })
    );
    expect(r.findings[0].owasp).toEqual(["A02"]);
  });

  it("preserves a multi-code array", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [
          {
            severity: "high",
            probe: "P",
            title: "t",
            file: "f",
            line: 1,
            owasp: ["LLM01", "LLM02"],
          },
        ],
        probeFailures: [],
        score: 0,
      })
    );
    expect(r.findings[0].owasp).toEqual(["LLM01", "LLM02"]);
  });

  it("omits the field when the engine sends nothing", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [{ severity: "low", probe: "P", title: "t", file: "f", line: 1 }],
        probeFailures: [],
        score: 0,
      })
    );
    expect(r.findings[0].owasp).toBeUndefined();
  });
});

describe("probe failures reach the caller", () => {
  // The defect this covers: failures were logged and discarded, so a scan
  // where every probe threw rendered as a clean 100/100.
  it("carries failures through to the report", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [],
        probeFailures: [
          { probe: "Secret Scanner", error: "boom" },
          { probe: "Taint Flow", error: "bang" },
        ],
        score: 100,
      })
    );
    expect(r.probeFailures).toHaveLength(2);
    expect(r.probeFailures[0].probe).toBe("Secret Scanner");
    expect(isScanIncomplete(r)).toBe(true);
  });

  it("does not tell the model the code is clean when probes failed", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [],
        probeFailures: [{ probe: "Secret Scanner", error: "boom" }],
        score: 100,
      })
    );
    const digest = formatFindingsForPrompt(r);
    expect(digest).toMatch(/not measured/i);
    expect(digest).not.toMatch(/do not invent/i);
  });

  it("warns in the digest even when findings exist alongside failures", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [{ severity: "high", probe: "P", title: "found", file: "f", line: 1 }],
        probeFailures: [{ probe: "Other", error: "boom" }],
        score: 40,
      })
    );
    const digest = formatFindingsForPrompt(r);
    expect(digest).toContain("found");
    expect(digest).toMatch(/absence of a finding does not mean/i);
  });
});

describe("malformed engine output", () => {
  it("survives a non-array findings field", () => {
    const r = runPreFlightScan(FILES, fake({ findings: "nope", probeFailures: [], score: 5 }));
    expect(r.findings).toEqual([]);
  });

  it("survives a missing result object", () => {
    for (const bad of [null, undefined, 42, "text"]) {
      const r = runPreFlightScan(FILES, fake(bad));
      expect(r.findings).toEqual([]);
      expect(r.score).toBe(0);
    }
  });

  it("survives a non-array probeFailures field", () => {
    const r = runPreFlightScan(FILES, fake({ findings: [], probeFailures: "nope", score: 1 }));
    expect(r.probeFailures).toEqual([]);
  });

  it("contains an engine that throws", () => {
    const r = runPreFlightScan(FILES, () => {
      throw new TypeError("pattern.includes is not a function");
    });
    expect(r.failed).toMatch(/pattern.includes/);
    expect(r.findings).toEqual([]);
  });

  it("truncates oversized evidence and remediation strings", () => {
    const r = runPreFlightScan(
      FILES,
      fake({
        findings: [
          {
            severity: "low",
            probe: "P",
            title: "t",
            file: "f",
            line: 1,
            evidence: "e".repeat(5000),
            remediation: "r".repeat(9000),
          },
        ],
        probeFailures: [],
        score: 0,
      })
    );
    expect(r.findings[0].evidence.length).toBe(500);
    expect(r.findings[0].remediation.length).toBe(2000);
  });
});
