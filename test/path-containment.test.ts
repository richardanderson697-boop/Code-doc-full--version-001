// resolveInsideDir is the single guard protecting every workspace file
// route. These cases are the ones the previous startsWith(dir) check let
// through, plus the ordinary traversal shapes.
import { describe, it, expect } from "vitest";
import path from "path";
import { resolveInsideDir } from "../server/workspace";

const BASE = path.resolve("C:/tmp/uploaded_project");

describe("resolveInsideDir", () => {
  it("accepts a plain relative path", () => {
    const r = resolveInsideDir(BASE, "src/App.tsx");
    expect(r).toBe(path.join(BASE, "src", "App.tsx"));
  });

  it("accepts a nested relative path", () => {
    const r = resolveInsideDir(BASE, "a/b/c/deep.ts");
    expect(r).toBe(path.join(BASE, "a", "b", "c", "deep.ts"));
  });

  it("treats a leading slash as workspace-relative, not absolute", () => {
    const r = resolveInsideDir(BASE, "/etc/passwd");
    expect(r).toBe(path.join(BASE, "etc", "passwd"));
  });

  it("rejects a sibling directory sharing the base prefix", () => {
    // The exact bypass the old fullPath.startsWith(uploadedDir) check
    // allowed: C:/tmp/uploaded_project-evil starts with the base string
    // but is not inside the base directory.
    expect(resolveInsideDir(BASE, "../uploaded_project-evil/steal.txt")).toBeNull();
  });

  it("rejects parent traversal with forward slashes", () => {
    expect(resolveInsideDir(BASE, "../../../etc/passwd")).toBeNull();
  });

  it("rejects parent traversal with backslashes", () => {
    expect(resolveInsideDir(BASE, "..\\..\\windows\\win.ini")).toBeNull();
  });

  it("rejects traversal that escapes then returns under a different name", () => {
    expect(resolveInsideDir(BASE, "a/../../outside.txt")).toBeNull();
  });

  it("rejects a traversal buried mid-path", () => {
    expect(resolveInsideDir(BASE, "src/../../escaped.ts")).toBeNull();
  });

  it("rejects an absolute Windows path on another drive root", () => {
    expect(resolveInsideDir(BASE, "C:\\Windows\\win.ini")).toBeNull();
  });

  it("rejects a path resolving to the base directory itself", () => {
    expect(resolveInsideDir(BASE, ".")).toBeNull();
    expect(resolveInsideDir(BASE, "src/..")).toBeNull();
  });

  it("rejects empty, whitespace, and non-string input", () => {
    expect(resolveInsideDir(BASE, "")).toBeNull();
    expect(resolveInsideDir(BASE, "   ")).toBeNull();
    expect(resolveInsideDir(BASE, null)).toBeNull();
    expect(resolveInsideDir(BASE, undefined)).toBeNull();
    expect(resolveInsideDir(BASE, 42)).toBeNull();
    expect(resolveInsideDir(BASE, { path: "x" })).toBeNull();
  });

  it("rejects a NUL byte, which can truncate paths in native calls", () => {
    expect(resolveInsideDir(BASE, "safe.txt\0../../etc/passwd")).toBeNull();
  });

  it("keeps the resolved path inside the base for every accepted input", () => {
    const accepted = ["a.ts", "/a.ts", "deep/nested/file.tsx", "./b.ts", "dir/./c.ts"];
    for (const p of accepted) {
      const r = resolveInsideDir(BASE, p);
      if (r === null) continue;
      const rel = path.relative(BASE, r);
      expect(rel.startsWith("..")).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
    }
  });
});
