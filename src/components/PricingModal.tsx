import React, { useEffect, useState } from "react";
import { X, Zap, Check } from "lucide-react";

interface Pack {
  id: string;
  name: string;
  priceCents: number;
  credits: number;
  tagline: string;
  available: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  notice?: string;
}

export default function PricingModal({ open, onClose, notice }: Props) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    fetch("/api/billing/packs", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setPacks(d.packs ?? []))
      .catch(() => setError("Could not load packs."));
  }, [open ]);

  if (!open) return null;

  const buy = async (packId: string) => {
    setBuying(packId);
    setError("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ packId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || "Checkout failed");
      setBuying(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold text-slate-100 flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" /> Buy credits
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-5">
          1 credit = 1¢ of AI compute. A deep workspace audit runs about 10–30 credits; quick chats are 1–3.
          Credits never expire.
        </p>
        {notice && (
          <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-4">{notice}</p>
        )}
        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-4">{error}</p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {packs.map((p) => (
            <div
              key={p.id}
              className={`rounded-xl border p-4 flex flex-col ${
                p.id === "builder" ? "border-emerald-500/40 bg-emerald-500/5" : "border-slate-800 bg-slate-950"
              }`}
            >
              {p.id === "builder" && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-2">Most popular</span>
              )}
              <div className="font-bold text-slate-100">{p.name}</div>
              <div className="text-2xl font-bold text-slate-100 mt-1">
                ${(p.priceCents / 100).toFixed(0)}
                <span className="text-xs font-normal text-slate-500"> one-time</span>
              </div>
              <div className="text-xs text-amber-300 font-medium mt-1 flex items-center gap-1">
                <Zap className="w-3 h-3" /> {p.credits.toLocaleString()} credits
              </div>
              <p className="text-xs text-slate-500 mt-2 mb-4">{p.tagline}</p>
              <button
                disabled={!p.available || buying !== null}
                onClick={() => buy(p.id)}
                className="mt-auto w-full py-2 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 transition"
              >
                {buying === p.id ? "Opening checkout…" : p.available ? "Buy" : "Unavailable"}
              </button>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-slate-600 mt-4 flex items-start gap-1">
          <Check className="w-3 h-3 mt-0.5 shrink-0" />
          Secure checkout by Stripe. The free deterministic PreFlight security scan always costs 0 credits.
        </p>
      </div>
    </div>
  );
}
