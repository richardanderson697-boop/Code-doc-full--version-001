import React, { useState } from "react";
import { X, Mail, Lock, Sparkles, ArrowLeft, CheckCircle2 } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  onAuthed: (user: { id: string; email: string; credits: number }) => void;
  initialMode?: "login" | "signup" | "forgot" | "reset";
  resetToken?: string | null;
  onResetComplete?: () => void;
}

type Mode = "login" | "signup" | "forgot" | "reset";

export default function AuthModal({ open, onClose, onAuthed, initialMode = "signup", resetToken = null, onResetComplete }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  // Sync to the parent's requested mode every time the modal opens (e.g.
  // the reset-password deep link opens us directly in "reset" mode).
  React.useEffect(() => {
    if (open) {
      setMode(initialMode);
      setError("");
      setForgotSent(false);
      setResetDone(false);
    }
  }, [open, initialMode, resetToken]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      onAuthed(data.user);
      setEmail("");
      setPassword("");
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      // Always the same message — the server never reveals whether the
      // email exists.
      setForgotSent(true);
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (password !== confirm) throw new Error("Passwords don't match.");
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setResetDone(true);
      setPassword("");
      setConfirm("");
      onResetComplete?.();
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Mode, string> = {
    signup: "Create your account",
    login: "Welcome back",
    forgot: "Reset your password",
    reset: "Set a new password",
  };
  const subtitles: Record<Mode, string> = {
    signup: "Sign up and get 25 free credits to try deep code audits.",
    login: "Sign in to use AI audits, generation, and debugging.",
    forgot: "Enter your account email and we'll send you a reset link.",
    reset: "Choose a new password for your account.",
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setError("");
    setForgotSent(false);
    setResetDone(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Sparkles className="w-4 h-4" />
            </div>
            <h3 className="font-bold text-slate-100">{titles[mode]}</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-5">{subtitles[mode]}</p>

        {(mode === "login" || mode === "signup") && (
          <div className="flex rounded-lg bg-slate-950 border border-slate-800 p-1 mb-4">
            {(["signup", "login"] as const).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={`flex-1 py-1.5 rounded-md text-xs font-medium transition ${
                  mode === m ? "bg-slate-800 text-slate-100" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {m === "signup" ? "Sign up" : "Sign in"}
              </button>
            ))}
          </div>
        )}

        {(mode === "login" || mode === "signup") && (
          <form onSubmit={submit} className="space-y-3">
            <label className="block">
              <span className="text-xs text-slate-400 mb-1 flex items-center gap-1"><Mail className="w-3 h-3" /> Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@indiedev.io"
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400 mb-1 flex items-center gap-1"><Lock className="w-3 h-3" /> Password</span>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
              />
            </label>
            {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 text-sm font-bold transition"
            >
              {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
            {mode === "login" && (
              <p className="text-center">
                <button type="button" onClick={() => switchMode("forgot")} className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2">
                  Forgot your password?
                </button>
              </p>
            )}
            {mode === "signup" && (
              <p className="text-[11px] text-slate-500 text-center leading-relaxed">
                By creating an account, you agree to our{" "}
                <button
                  type="button"
                  onClick={() => { window.location.hash = "terms"; }}
                  className="text-slate-400 hover:text-slate-200 underline underline-offset-2"
                >
                  Terms of Service
                </button>{" "}
                and{" "}
                <button
                  type="button"
                  onClick={() => { window.location.hash = "privacy"; }}
                  className="text-slate-400 hover:text-slate-200 underline underline-offset-2"
                >
                  Privacy Policy
                </button>
                .
              </p>
            )}
          </form>
        )}

        {mode === "forgot" && (
          forgotSent ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>If an account exists for that email, a reset link is on its way. It expires in 1 hour.</span>
              </div>
              <button onClick={() => switchMode("login")} className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition">
                <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={submitForgot} className="space-y-3">
              <label className="block">
                <span className="text-xs text-slate-400 mb-1 flex items-center gap-1"><Mail className="w-3 h-3" /> Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@indiedev.io"
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </label>
              {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 text-sm font-bold transition"
              >
                {busy ? "Sending…" : "Send reset link"}
              </button>
              <button type="button" onClick={() => switchMode("login")} className="w-full flex items-center justify-center gap-1.5 py-1 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition">
                <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
              </button>
            </form>
          )
        )}

        {mode === "reset" && (
          resetDone ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Password updated. Sign in with your new password.</span>
              </div>
              <button onClick={() => switchMode("login")} className="w-full py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-bold transition">
                Sign in
              </button>
            </div>
          ) : (
            <form onSubmit={submitReset} className="space-y-3">
              <label className="block">
                <span className="text-xs text-slate-400 mb-1 flex items-center gap-1"><Lock className="w-3 h-3" /> New password</span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-slate-400 mb-1 flex items-center gap-1"><Lock className="w-3 h-3" /> Confirm new password</span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat the new password"
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </label>
              {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 text-sm font-bold transition"
              >
                {busy ? "Please wait…" : "Set new password"}
              </button>
            </form>
          )
        )}
      </div>
    </div>
  );
}
