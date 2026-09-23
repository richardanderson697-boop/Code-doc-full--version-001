// The CI templates are user-facing output: they get pasted into real
// repositories, so the config values must land in them correctly.
import { describe, it, expect } from "vitest";
import { buildWorkflowYaml, buildAuditScript, GithubCiConfig } from "../src/components/auditor/githubCiTemplates";

const cfg: GithubCiConfig = {
  repoOwner: "acme-corp",
  repoName: "widget-app",
  branchName: "release",
  secretName: "MY_GEMINI_KEY",
  targetFile: "src/pages/Dashboard.tsx",
  outputFolder: "reports/audits",
  failUnderScore: 75,
  postPrComment: true,
};

describe("buildWorkflowYaml", () => {
  it("uses the configured branch and secret name", () => {
    const yaml = buildWorkflowYaml(cfg);
    expect(yaml).toContain("release");
    expect(yaml).toContain("MY_GEMINI_KEY");
  });

  it("produces a workflow with a name, triggers, and a job", () => {
    const yaml = buildWorkflowYaml(cfg);
    expect(yaml).toMatch(/^name:/m);
    expect(yaml).toMatch(/^on:/m);
    expect(yaml).toMatch(/^jobs:/m);
  });

  it("changes output when the branch changes", () => {
    const a = buildWorkflowYaml(cfg);
    const b = buildWorkflowYaml({ ...cfg, branchName: "develop" });
    expect(a).not.toBe(b);
    expect(b).toContain("develop");
  });
});

describe("buildAuditScript", () => {
  it("embeds the target file, output folder, and threshold", () => {
    const js = buildAuditScript(cfg);
    expect(js).toContain("src/pages/Dashboard.tsx");
    expect(js).toContain("reports/audits");
    expect(js).toContain("75");
  });

  it("references the configured secret rather than a literal key", () => {
    const js = buildAuditScript(cfg);
    expect(js).toContain("MY_GEMINI_KEY");
    expect(js).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
  });

  it("reacts to the PR comment toggle", () => {
    const on = buildAuditScript({ ...cfg, postPrComment: true });
    const off = buildAuditScript({ ...cfg, postPrComment: false });
    expect(on).not.toBe(off);
  });

  it("is a non-trivial script both ways", () => {
    expect(buildAuditScript(cfg).length).toBeGreaterThan(500);
    expect(buildWorkflowYaml(cfg).length).toBeGreaterThan(200);
  });
});
