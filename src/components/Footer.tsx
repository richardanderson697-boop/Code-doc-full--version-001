import React from "react";

export function openLegal(doc: "privacy" | "terms") {
  window.location.hash = doc === "privacy" ? "privacy" : "terms";
}

export default function Footer() {
  return (
    <footer className="shrink-0 border-t border-slate-800/60 bg-slate-950 px-5 py-3">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between max-w-full">
        <p className="text-[11px] text-slate-600 font-mono">
          GradeVibes · Static analysis — no code was executed
        </p>
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <button
            onClick={() => openLegal("privacy")}
            className="text-slate-500 hover:text-slate-300 transition"
          >
            Privacy Policy
          </button>
          <span className="text-slate-800">·</span>
          <button
            onClick={() => openLegal("terms")}
            className="text-slate-500 hover:text-slate-300 transition"
          >
            Terms of Service
          </button>
        </div>
      </div>
    </footer>
  );
}
