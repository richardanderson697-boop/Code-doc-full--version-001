// Header identity: README title/tagline extraction, the report title
// fallback chain (caller > README H1 > import source > generic), and
// workspace-source persistence. The Automate-AI-v3 fixture is the live
// case: its README H1 was in the scanned workspace, yet the header
// printed the generic fallback.
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";

import authRouter from "../server/routes/auth";
import { initStore, getDb } from "../server/store";
import {
  getWorkspaceSource,
  replaceWorkspaceFiles,
  clearWorkspaceFiles,
} from "../server/workspace-store";
import {
  findReadmeFile,
  extractReadmeTitle,
  extractReadmeTagline,
} from "../server/readme-identity";
import { intelResultToFinalReadInput } from "../src/components/auditor/FinalReadOverlay";
import { buildFinalReadReport } from "../shared/finalread-report";

const AUTOMATE_README = [
  "# Automate-AI-v3 🏎️🤖",
  "",
  "The AI-Powered Intelligence Layer for Modern Automotive Shops.",
  "",
  "Automate-AI-v3 bridges the gap between legacy Shop Management Systems",
  "(SMS) and cutting-edge AI diagnostics.",
  "",
  "## Key Features",
  "",
  "- RAG Diagnostic Engine: verified repair solutions.",
].join("\n");

describe("extractReadmeTitle", () => {
  it("strips emoji decoration from the H1", () => {
    expect(extractReadmeTitle(AUTOMATE_README)).toBe("Automate-AI-v3");
  });
  it("handles closed ATX headings and markdown links", () => {
    expect(extractReadmeTitle("# My App #\n\nBody.")).toBe("My App");
    expect(extractReadmeTitle("# [Linked Name](https://example.com)\n")).toBe(
      "Linked Name"
    );
  });
  it("ignores H2-only documents and empties", () => {
    expect(extractReadmeTitle("## Only a subheading\n\nBody.")).toBeUndefined();
    expect(extractReadmeTitle("")).toBeUndefined();
  });
});

describe("extractReadmeTagline", () => {
  it("takes the paragraph after the H1", () => {
    expect(extractReadmeTagline(AUTOMATE_README)).toBe(
      "The AI-Powered Intelligence Layer for Modern Automotive Shops."
    );
  });
  it("skips badges and HTML before the paragraph", () => {
    const doc = [
      "# App",
      "",
      "[![Build](https://example.com/badge.svg)](https://example.com)",
      "<div>banner</div>",
      "",
      "Real tagline here.",
    ].join("\n");
    expect(extractReadmeTagline(doc)).toBe("Real tagline here.");
  });
  it("stops at a heading before any paragraph", () => {
    const doc = ["# App", "", "## Key Features", "", "- A feature."].join("\n");
    expect(extractReadmeTagline(doc)).toBeUndefined();
  });
});

describe("findReadmeFile", () => {
  it("prefers the root README and matches case-insensitively", () => {
    const files = [
      { path: "docs/README.md", content: "nested" },
      { path: "Readme.MD", content: "root" },
    ];
    expect(findReadmeFile(files)?.content).toBe("root");
  });
  it("returns undefined when no README exists", () => {
    expect(findReadmeFile([{ path: "src/a.ts", content: "" }])).toBeUndefined();
  });
});

describe("report header title chain", () => {
  function headerFor(intel: any, title?: string) {
    const report = buildFinalReadReport(
      intelResultToFinalReadInput(intel, title)
    );
    return { title: report.projectTitle, summary: report.applicationSummary };
  }
  const base = { completenessScore: 60, categoryScores: {} };

  it("caller title wins over README and import source", () => {
    const h = headerFor(
      {
        ...base,
        displayName: "Readme Name",
        importSource: { kind: "github", owner: "o", repo: "r" },
      },
      "o/r"
    );
    expect(h.title).toBe("o/r");
  });
  it("README H1 wins over the import source", () => {
    const h = headerFor({
      ...base,
      displayName: "Readme Name",
      importSource: { kind: "github", owner: "o", repo: "r" },
    });
    expect(h.title).toBe("Readme Name");
  });
  it("GitHub import source renders as owner/repo", () => {
    const h = headerFor({
      ...base,
      importSource: { kind: "github", owner: "acme", repo: "shop-app" },
    });
    expect(h.title).toBe("acme/shop-app");
  });
  it("ZIP source renders as the filename without .zip", () => {
    const h = headerFor({
      ...base,
      importSource: { kind: "zip", filename: "my-app.zip" },
    });
    expect(h.title).toBe("my-app");
  });
  it("falls back to Reviewed project only when nothing is known", () => {
    expect(headerFor(base).title).toBe("Reviewed project");
  });
  it("description prefers the summary, then the README tagline", () => {
    expect(
      headerFor({ ...base, overallSummary: "Full summary.", readmeTagline: "Tag." })
        .summary
    ).toBe("Full summary.");
    expect(headerFor({ ...base, readmeTagline: "Tag." }).summary).toBe("Tag.");
    expect(headerFor(base).summary).toBeUndefined();
  });
});

describe("workspace source persistence", () => {
  let userId = "";
  function buildApp() {
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use(authRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err?.status || 500).json({ error: err?.message || "server error" });
    });
    return app;
  }

  beforeAll(async () => {
    await initStore();
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: `header-test-${Date.now()}@x.io`, password: "supersecret1" });
    expect(res.status).toBe(201);
    userId = res.body.user.id;
  });

  it("records a GitHub source and reads it back", async () => {
    await replaceWorkspaceFiles(
      userId,
      [{ path: "README.md", content: "# App" }],
      {
        kind: "github",
        owner: "acme",
        repo: "shop-app",
        url: "https://github.com/acme/shop-app",
      }
    );
    expect(await getWorkspaceSource(userId)).toEqual({
      kind: "github",
      owner: "acme",
      repo: "shop-app",
      url: "https://github.com/acme/shop-app",
    });
  });
  it("replacing without a source clears the stale source", async () => {
    await replaceWorkspaceFiles(userId, [{ path: "src/a.ts", content: "x" }]);
    expect(await getWorkspaceSource(userId)).toBeUndefined();
  });
  it("clearing the workspace clears the source", async () => {
    await replaceWorkspaceFiles(
      userId,
      [{ path: "README.md", content: "# App" }],
      { kind: "zip", filename: "app.zip" }
    );
    expect(await getWorkspaceSource(userId)).toEqual({
      kind: "zip",
      filename: "app.zip",
    });
    await clearWorkspaceFiles(userId);
    expect(await getWorkspaceSource(userId)).toBeUndefined();
  });
  it("ignores a malformed stored kind instead of surfacing it", async () => {
    await getDb().run(
      `INSERT INTO workspace_sources (user_id, kind, owner, repo, url, filename, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET kind = excluded.kind`,
      [userId, "bogus", null, null, null, null, new Date().toISOString()]
    );
    expect(await getWorkspaceSource(userId)).toBeUndefined();
  });
});
