// Authenticated fetch wrapper. Always sends the session cookie.
// On 401 it fires `codedoc:auth-required`; on 402 `codedoc:credits-required`
// (with { balance, required }); App listens and opens the right modal.
export class AuthRequiredError extends Error {
  constructor() { super("Sign in required"); this.name = "AuthRequiredError"; }
}
export class CreditsRequiredError extends Error {
  balance: number;
  required: number;
  constructor(balance: number, required: number) {
    super("Not enough credits");
    this.name = "CreditsRequiredError";
    this.balance = balance;
    this.required = required;
  }
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (res.status === 401) {
    const clone = res.clone();
    let code = "";
    try { code = (await clone.json())?.code ?? ""; } catch { /* non-JSON */ }
    if (code === "AUTH_REQUIRED" || String(input).startsWith("/api/auth")) {
      window.dispatchEvent(new CustomEvent("codedoc:auth-required"));
      throw new AuthRequiredError();
    }
  }
  if (res.status === 402) {
    let balance = 0, required = 0;
    try { const j = await res.clone().json(); balance = j.balance ?? 0; required = j.required ?? 0; } catch { /* noop */ }
    window.dispatchEvent(new CustomEvent("codedoc:credits-required", { detail: { balance, required } }));
    throw new CreditsRequiredError(balance, required);
  }
  return res;
}

// Plain GET for the current session; never throws the modal events.
export async function fetchMe(): Promise<{ id: string; email: string; credits: number } | null> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user ?? null;
  } catch {
    return null;
  }
}
