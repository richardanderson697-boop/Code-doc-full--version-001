import React from "react";

export function openLegal(doc: "privacy" | "terms") {
  window.location.hash = doc === "privacy" ? "privacy" : "terms";
}

export default function Footer({ brand = "GradeVibes" }: { brand?: string }) {
  // Two-sided flow §1 + front-door §4: on the FinalRead host the footer
  // is light and links back to the developer workspace; on gradevibes.com
  // the FinalRead discovery link is a REAL anchor to getfinalread.com
  // (the wrong-host rule: #finalread on gradevibes.com redirects there).
  const isFinalRead = brand === "FinalRead";
  return (
    <footer
      className={
        isFinalRead
          ? "shrink-0 border-t border-slate-200 bg-white px-5 py-3"
          : "shrink-0 border-t border-slate-800/60 bg-slate-950 px-5 py-3"
      }
    >
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between max-w-full">
        <p className={isFinalRead ? "text-[11px] text-slate-500 font-mono" : "text-[11px] text-slate-600 font-mono"}>
          {brand} · Static analysis — no code was executed
        </p>
        <div className="flex items-center gap-4 text-[11px] font-mono">
          {isFinalRead ? (
            <a
              href="https://gradevibes.com"
              className="text-slate-500 hover:text-slate-800 transition"
            >
              Developer workspace — gradevibes.com
            </a>
          ) : (
            <>
              <a
                href="https://getfinalread.com"
                className="text-slate-500 hover:text-slate-300 transition"
              >
                Buying or investing in software? FinalRead
              </a>
              <span className="text-slate-800">·</span>
            </>
          )}
          <button
            onClick={() => openLegal("privacy")}
            className={isFinalRead ? "text-slate-500 hover:text-slate-800 transition" : "text-slate-500 hover:text-slate-300 transition"}
          >
            Privacy Policy
          </button>
          <span className={isFinalRead ? "text-slate-300" : "text-slate-800"}>·</span>
          <button
            onClick={() => openLegal("terms")}
            className={isFinalRead ? "text-slate-500 hover:text-slate-800 transition" : "text-slate-500 hover:text-slate-300 transition"}
          >
            Terms of Service
          </button>
        </div>
      </div>
    </footer>
  );
}
