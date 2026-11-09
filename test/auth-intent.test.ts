// Auth-intent detection tests (finalread-auth-intent-detection-spec.md).
// A README that describes authentication, role-based access, or several
// distinct user roles declares auth as intended — so missing auth is a
// docked gap (score 2, note "dangling-auth"), not "not applicable".
import { describe, it, expect } from "vitest";
import { computeDeterministicAssessment } from "../server/deterministic-score";
import type { PreFlightReport } from "../shared/preflight-types";
import type { WorkspaceFile } from "../server/workspace";

function wf(path: string, content: string): WorkspaceFile {
  return { path, content, lineCount: content.split("\n").length } as WorkspaceFile;
}

function emptyPreflight(score = 100): PreFlightReport {
  return {
    engine: "PreFlight",
    probeCount: 113,
    filesScanned: 1,
    filesSkipped: [],
    score,
    counts: {},
    findings: [],
    probeFailures: [],
    failed: null,
  };
}

const PKG = wf("package.json", JSON.stringify({ dependencies: { react: "18" } }));
const HTML = wf("index.html", "<div id=root></div>");
const PLAIN_APP = wf(
  "src/App.tsx",
  `export function App() { return <div>Rentals</div>; }`
);

// RentStream-shaped README: "Authentication" on line 7, "Role-Based
// Access" on line 11, landlord/tenant/maintenance roles throughout.
const RENTSTREAM_README = `# RentStream Platform

RentStream bridges landlords, tenants, and maintenance personnel.

## Architecture

- **apps/api**: NestJS backend handling REST APIs, Authentication, and Cron jobs.

## Key Features

- **Role-Based Access**: Specialized views for Landlords, Tenants, and Maintenance.
`;

describe("auth intent from documentation", () => {
  it("docks auth when the README describes authentication and roles (RentStream shape)", () => {
    const files = [PKG, HTML, PLAIN_APP, wf("README.md", RENTSTREAM_README)];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.score).toBe(2);
    expect(a.categories.authentication.note).toBe("dangling-auth");
    expect(a.categories.authentication.applicable).not.toBe(false);
    expect(a.categories.authentication.evidence.join(" ")).toMatch(/README\.md:7/);
    expect(a.missingFeatures.some((m) => /Implement authentication backend/i.test(m.feature))).toBe(true);
  });

  it("fires on role plurality alone, with no explicit 'authentication' word", () => {
    const readme = `# Rentals

Built for the landlord and the tenant.
Maintenance crews get their own views.
`;
    const files = [PKG, HTML, PLAIN_APP, wf("README.md", readme)];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.score).toBe(2);
    expect(a.categories.authentication.note).toBe("dangling-auth");
    expect(a.categories.authentication.evidence.join(" ")).toMatch(/multiple user roles/);
  });

  it("does NOT fire on a single role word alone", () => {
    const readme = `# Tool

An admin panel is included for convenience.
`;
    const files = [PKG, HTML, PLAIN_APP, wf("README.md", readme)];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.applicable).toBe(false);
    expect(a.categories.authentication.note).toBe("not-applicable");
    expect(a.categories.authentication.evidence.join(" ")).toMatch(/no evidence found/);
  });

  it("declared no-auth design still wins over doc intent (precedence)", () => {
    const readme = `# Tool

No authentication — personal use only.
Built for landlords and tenants.
`;
    const files = [PKG, HTML, PLAIN_APP, wf("README.md", readme)];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.applicable).toBe(false);
    expect(a.categories.authentication.note).toBe("excluded-by-design");
  });

  it("implemented auth still scores 10 (regression)", () => {
    const files = [
      PKG,
      HTML,
      PLAIN_APP,
      wf("src/auth.ts", `import jwt from 'jsonwebtoken';\nexport function verify(t: string) { return jwt.verify(t, 's'); }\n`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.score).toBe(10);
  });

  it("existing UI dangling case still scores 2 (regression — Whistle-stop shape)", () => {
    const files = [
      PKG,
      HTML,
      wf("src/App.tsx", `export function App() { return <button>Sign in</button>; }`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.score).toBe(2);
    expect(a.categories.authentication.note).toBe("dangling-auth");
    expect(a.missingFeatures.some((m) => /authentication/i.test(m.feature))).toBe(true);
  });

  it("no README, no roles, no auth stays N/A (regression)", () => {
    const files = [
      PKG,
      HTML,
      wf("src/App.tsx", `export function App() { const [t, setT] = React.useState(''); return <textarea value={t}/>; }`),
    ];
    const a = computeDeterministicAssessment(files, emptyPreflight());
    expect(a.categories.authentication.applicable).toBe(false);
    expect(a.categories.authentication.note).toBe("not-applicable");
    expect(a.categories.authentication.score).toBe(0);
    expect(a.categories.authentication.evidence.join(" ")).toMatch(/no evidence found/);
  });
});
