// Rung 1c: the fast-hash gate needs a credential word on the call's own
// lines (the createHash line plus its chained continuations) or in the
// enclosing signature — not merely in the ±4-line window — plus a
// token-naming counter-signal. The broken-hash (md5/sha1) gate is
// untouched. (server/preflight/vendor/lib/probes/crypto.js ->
// probeWeakCryptography.)
import { describe, it, expect } from "vitest";
import { probeWeakCryptography } from "../server/preflight/vendor/lib/probes/crypto.js";

function run(content: string) {
  return probeWeakCryptography([{ path: "server/routes/auth.ts", content }]);
}

function fastHash(findings: Array<{ title: string; severity: string }>) {
  return findings.filter((f) => f.title.includes("no key derivation function"));
}

describe("probeWeakCryptography — fast-hash gate (rung 1c)", () => {
  it("still fires HIGH when the signature names the credential", () => {
    const findings = run(`
export function hashPassword(pw: string): string {
  const h = crypto.createHash('sha256');
  h.update(pw);
  return h.digest('hex');
}`);
    const hits = fastHash(findings);
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe("high");
  });

  it("still fires HIGH when a chained continuation names the credential", () => {
    const findings = run(`
const password = loadSecret();
export function computeDigest(input: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(password)
    .digest('hex');
  return digest;
}`);
    const hits = fastHash(findings);
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe("high");
  });

  it("does not fire when the password word is only in a neighboring statement", () => {
    const findings = run(`
export function computeDigest(data: string): string {
  const password = getPassword();
  const h = crypto.createHash('sha256');
  h.update(data);
  return h.digest('hex');
}`);
    expect(fastHash(findings)).toEqual([]);
  });

  it("does not fire on a token hash sitting next to password code", () => {
    const findings = run(`
export function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
export function setPassword(password: string) {
  return password;
}`);
    expect(fastHash(findings)).toEqual([]);
  });

  it("still fires when a credential word is named even alongside token naming", () => {
    const findings = run(`
export function computeDigest(input: string): string {
  const passwordResetToken = input;
  const h = crypto.createHash('sha256');
  h.update(passwordResetToken);
  return h.digest('hex');
}`);
    const hits = fastHash(findings);
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe("high");
  });

  it("leaves the broken-hash gate untouched: md5 still fires on window-only evidence", () => {
    const findings = run(`
export function computeDigest(data: string): string {
  const password = getPassword();
  const h = crypto.createHash('md5');
  h.update(data);
  return h.digest('hex');
}`);
    const hits = findings.filter((f) => f.title.startsWith("Credential hashed with"));
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe("critical");
    expect(hits[0].title).toContain("md5");
  });
});
