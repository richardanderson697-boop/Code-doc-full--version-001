// The original regex evidence scan still feeds the cold-audit sheet.
// These pin its behavior so the PreFlight layer landing beside it cannot
// silently change what it reports.
import { describe, it, expect } from "vitest";
import { runDeterministicScan } from "../server/deterministic-scan";

describe("runDeterministicScan", () => {
  it("counts express endpoints", () => {
    const s = runDeterministicScan(`app.get("/a", h);\napp.post("/b", h);\nrouter.delete("/c", h);`);
    expect(s.endpointCount).toBe(3);
    expect(s.endpoints[0].lines).toBe("1");
  });

  it("counts fetch and axios calls but not commented ones", () => {
    const s = runDeterministicScan(`fetch("/api/x");\n// fetch("/api/y");\naxios.post("/api/z");`);
    expect(s.fetchCount).toBe(2);
  });

  it("finds TODO and FIXME markers only in comments", () => {
    const s = runDeterministicScan(`// TODO: wire this up\nconst label = "TODO in a string";\n// FIXME: broken`);
    expect(s.todoCount).toBe(2);
  });

  it("flags a hardcoded port and clears it when process.env.PORT is used", () => {
    const hard = runDeterministicScan(`app.listen(3000);`);
    expect(hard.hardcodedPortCount).toBe(1);
    expect(hard.usesProcessEnvPort).toBe(false);

    const soft = runDeterministicScan(`const PORT = process.env.PORT || 3000;\napp.listen(PORT);`);
    expect(soft.usesProcessEnvPort).toBe(true);
  });

  it("counts any-type bypasses", () => {
    const s = runDeterministicScan(`function f(x: any) {}\nconst y = z as any;\nconst ok: string = "s";`);
    expect(s.anyCount).toBe(2);
  });

  it("finds commented-out schedulers", () => {
    const s = runDeterministicScan(`// setInterval(tick, 1000);\nsetInterval(realTick, 1000);`);
    expect(s.commentedSchedulersCount).toBe(1);
  });

  it("detects test assertions", () => {
    const s = runDeterministicScan(`describe("x", () => {\n  it("works", () => {\n    expect(1).toBe(1);\n  });\n});`);
    expect(s.testCount).toBeGreaterThan(0);
  });

  it("returns zeroed counts for an empty file", () => {
    const s = runDeterministicScan("");
    expect(s.endpointCount).toBe(0);
    expect(s.fetchCount).toBe(0);
    expect(s.todoCount).toBe(0);
    expect(s.anyCount).toBe(0);
  });

  it("reports 1-based line numbers", () => {
    const s = runDeterministicScan(`const a = 1;\nconst b = 2;\napp.get("/x", h);`);
    expect(s.endpoints[0].lines).toBe("3");
  });
});
