// Repo-URL import validation: the SSRF story lives or dies here. Every
// non-github.com host, every non-https scheme, and every malformed path must
// be rejected — the fetcher only ever builds URLs from validated components.
import { describe, it, expect } from "vitest";
import {
  parseGitHubRepoUrl,
  isValidRef,
  buildArchiveUrl,
  isAllowedFetchHost,
} from "../server/repo-import";

describe("parseGitHubRepoUrl", () => {
  it("accepts a plain repo URL", () => {
    expect(parseGitHubRepoUrl("https://github.com/octocat/hello-world")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("assumes https when the scheme is omitted (mobile pastes)", () => {
    expect(parseGitHubRepoUrl("github.com/octocat/hello-world")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("ignores extra path segments beyond owner/repo", () => {
    expect(parseGitHubRepoUrl("https://github.com/octocat/hello-world/tree/main")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("accepts trailing slash and .git suffix", () => {
    expect(parseGitHubRepoUrl("https://github.com/octocat/hello-world/")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
    expect(parseGitHubRepoUrl("https://github.com/octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("rejects non-GitHub hosts (SSRF)", () => {
    expect(parseGitHubRepoUrl("https://evil.com/octocat/hello-world")).toBeNull();
    expect(parseGitHubRepoUrl("https://github.com.evil.com/octocat/hello-world")).toBeNull();
    expect(parseGitHubRepoUrl("http://169.254.169.254/latest/meta-data")).toBeNull();
    expect(parseGitHubRepoUrl("https://raw.githubusercontent.com/o/r/main/f")).toBeNull();
  });

  it("rejects non-https schemes", () => {
    expect(parseGitHubRepoUrl("http://github.com/octocat/hello-world")).toBeNull();
    expect(parseGitHubRepoUrl("ftp://github.com/octocat/hello-world")).toBeNull();
  });

  it("rejects malformed paths", () => {
    expect(parseGitHubRepoUrl("https://github.com/octocat")).toBeNull();
    expect(parseGitHubRepoUrl("https://github.com/")).toBeNull();
    expect(parseGitHubRepoUrl("not a url")).toBeNull();
    expect(parseGitHubRepoUrl(null)).toBeNull();
    expect(parseGitHubRepoUrl(42)).toBeNull();
  });

  it("uses only owner/repo when extra path segments are pasted", () => {
    expect(parseGitHubRepoUrl("https://github.com/o/r/extra/path")).toEqual({
      owner: "o",
      repo: "r",
    });
  });
});

describe("isValidRef", () => {
  it("accepts normal branch names", () => {
    expect(isValidRef("main")).toBe(true);
    expect(isValidRef("feature/my-branch_2")).toBe(true);
    expect(isValidRef("v1.2.3")).toBe(true);
  });

  it("rejects traversal and junk", () => {
    expect(isValidRef("../etc")).toBe(false);
    expect(isValidRef("a b")).toBe(false);
    expect(isValidRef("")).toBe(false);
    expect(isValidRef("x".repeat(129))).toBe(false);
    expect(isValidRef(null)).toBe(false);
  });
});

describe("buildArchiveUrl / isAllowedFetchHost", () => {
  it("builds the archive URL from components only", () => {
    expect(buildArchiveUrl("octocat", "hello-world", "main")).toBe(
      "https://github.com/octocat/hello-world/archive/refs/heads/main.zip"
    );
  });

  it("encodes branch names", () => {
    expect(buildArchiveUrl("o", "r", "feature/x")).toBe(
      "https://github.com/o/r/archive/refs/heads/feature%2Fx.zip"
    );
  });

  it("allowlist covers only github.com and codeload.github.com", () => {
    expect(isAllowedFetchHost("github.com")).toBe(true);
    expect(isAllowedFetchHost("codeload.github.com")).toBe(true);
    expect(isAllowedFetchHost("evil.com")).toBe(false);
    expect(isAllowedFetchHost("github.com.evil.com")).toBe(false);
  });
});
