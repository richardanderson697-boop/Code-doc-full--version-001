// Rung 1b: a comparison against a confirmation value is not a plaintext
// password comparison. `password !== confirm` in a reset form compares a
// new value against its confirmation — no stored credential is involved.
// (server/preflight/vendor/lib/probes/auth.js -> probeAuthWeakness.)
import { describe, it, expect } from "vitest";
import { probeAuthWeakness } from "../server/preflight/vendor/lib/probes/auth.js";

function run(content: string) {
  return probeAuthWeakness([{ path: "src/components/AuthModal.tsx", content }]);
}

function plaintextComparisons(findings: Array<{ title: string; severity: string }>) {
  return findings.filter((f) => f.title === "Plaintext password comparison");
}

describe("probeAuthWeakness — confirmation-operand suppression (rung 1b)", () => {
  it("does not fire on `password !== confirm`", () => {
    const findings = run(`
export function ResetForm({ password, confirm }: { password: string; confirm: string }) {
  if (password !== confirm) {
    return "Passwords do not match";
  }
  return "ok";
}`);
    expect(plaintextComparisons(findings)).toEqual([]);
  });

  it("does not fire on `password !== confirmPassword`", () => {
    const findings = run(`
export function ResetForm({ password, confirmPassword }: { password: string; confirmPassword: string }) {
  if (password !== confirmPassword) {
    return "Passwords do not match";
  }
  return "ok";
}`);
    expect(plaintextComparisons(findings)).toEqual([]);
  });

  it("does not fire when the confirmation operand comes first", () => {
    const findings = run(`
export function ResetForm({ password, confirm }: { password: string; confirm: string }) {
  if (confirm !== password) {
    return "Passwords do not match";
  }
  return "ok";
}`);
    expect(plaintextComparisons(findings)).toEqual([]);
  });

  it("does not fire on `newPassword !== repeatPassword`", () => {
    const findings = run(`
export function ResetForm({ newPassword, repeatPassword }: { newPassword: string; repeatPassword: string }) {
  if (newPassword !== repeatPassword) {
    return "Passwords do not match";
  }
  return "ok";
}`);
    expect(plaintextComparisons(findings)).toEqual([]);
  });

  it("still fires CRITICAL on `req.body.password === user.password`", () => {
    const findings = run(`
export function checkLogin(req: any, user: any) {
  if (req.body.password === user.password) {
    return true;
  }
  return false;
}`);
    const hits = plaintextComparisons(findings);
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe("critical");
  });

  it("still fires CRITICAL on `input !== password`", () => {
    // Spec discrepancy (reported, not improvised around): the spec's
    // pair names `input !== user.password`, but the pristine probe
    // never detected that shape — its second pattern requires a BARE
    // password-named right operand (no dots allowed), verified against
    // the unmodified file (0 findings). Extending detection is out of
    // rung 1b's scope, so this test pins the equivalent shape the probe
    // actually covers: a non-confirmation comparison still fires.
    const findings = run(`
export function checkInput(input: string, password: string) {
  if (input !== password) {
    return false;
  }
  return true;
}`);
    const hits = plaintextComparisons(findings);
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe("critical");
  });

  it("still fires on a comparison against a non-confirmation value", () => {
    const findings = run(`
export function checkStored(password: string, stored: string) {
  if (password === stored) {
    return true;
  }
  return false;
}`);
    const hits = plaintextComparisons(findings);
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe("critical");
  });
});
