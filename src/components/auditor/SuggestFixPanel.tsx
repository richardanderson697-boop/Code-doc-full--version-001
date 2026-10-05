// Per-finding "Suggest fix" — calls POST /api/suggest-fix and renders the
// returned suggestion as a review panel. The fix is NEVER applied to user
// code: this is explanation + review + export only, shaped as the shared
// developer handoff packet (see docs/dev-handoff-packet-schema.md).
import { useState } from "react";
import { Download, Loader2, Sparkles, XCircle } from "lucide-react";
import { apiFetch } from "../../utils/apiFetch";
import {
  renderDevHandoffPacket,
  type DevHandoffFinding,
  type SuggestedFix,
} from "../../../shared/dev-handoff-packet";

interface SuggestFixPanelProps {
  finding: DevHandoffFinding;
  /** Snippet shown to the model as the problem context. */
  codeContext?: string;
}

type Phase = "idle" | "loading" | "done" | "error";

function packetFilename(file: string): string {
  const base = file.split("/").pop() || "finding";
  const safe = base.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `suggested-fix-${safe || "finding"}.md`;
}

function downloadMarkdown(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export default function SuggestFixPanel({ finding, codeContext }: SuggestFixPanelProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [fix, setFix] = useState<SuggestedFix | null>(null);
  const [error, setError] = useState("");

  const handleSuggest = async () => {
    if (phase === "loading") return;
    setPhase("loading");
    setError("");
    try {
      const res = await apiFetch("/api/suggest-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: finding.file,
          line: finding.line,
          message: finding.message,
          severity: finding.severity,
          type: finding.type,
          suggestion: finding.suggestion,
          codeContext,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Could not generate a suggested fix.");
      }
      const data = await res.json();
      if (!data.suggestion?.remediationDiff) {
        throw new Error("The server returned an unusable suggestion. No credits were charged.");
      }
      setFix(data.suggestion as SuggestedFix);
      setPhase("done");
    } catch (err: any) {
      // 401/402 already surface the app's sign-in / top-up modals via apiFetch.
      setError(err?.message || "Could not generate a suggested fix.");
      setPhase("error");
    }
  };

  const handleExport = () => {
    if (!fix) return;
    const markdown = renderDevHandoffPacket({
      product: "GradeVibes",
      finding,
      fix,
      generatedAt: new Date().toISOString(),
    });
    downloadMarkdown(packetFilename(finding.file), markdown);
  };

  if (phase === "idle" || phase === "loading") {
    return (
      <button
        type="button"
        onClick={handleSuggest}
        disabled={phase === "loading"}
        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 rounded-lg text-[10px] font-semibold border border-indigo-500/30 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {phase === "loading" ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Drafting suggested fix…</span>
          </>
        ) : (
          <>
            <Sparkles className="w-3 h-3" />
            <span>Suggest fix</span>
          </>
        )}
      </button>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex items-center gap-2">
        <p className="text-[10px] text-rose-400/90 font-mono bg-slate-950/80 border border-rose-500/10 p-2 rounded-lg select-text flex items-center gap-1.5">
          <XCircle className="w-3 h-3 shrink-0" />
          {error}
        </p>
        <button
          type="button"
          onClick={handleSuggest}
          className="px-2 py-1 text-[10px] text-slate-400 hover:text-slate-200 underline shrink-0"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-2.5 bg-slate-950/60 border border-indigo-500/20 rounded-xl p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-300">
          Suggested fix — review only
        </span>
        <button
          type="button"
          onClick={handleExport}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-[10px] font-semibold border border-slate-700 transition"
        >
          <Download className="w-3 h-3" />
          <span>Export handoff packet (.md)</span>
        </button>
      </div>

      <p className="text-[10px] text-amber-300/90 bg-amber-500/5 border border-amber-500/15 rounded-lg p-2 leading-relaxed">
        Nothing in your code was changed. This is a proposal for a developer to
        review — apply it yourself only after you agree with it.
      </p>

      <div>
        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-1">
          What's wrong, in plain English
        </p>
        <p className="text-[11px] text-slate-300 leading-relaxed select-text">{fix!.plainEnglishIssue}</p>
      </div>

      {fix!.evidence && (
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-1">Evidence</p>
          <pre className="font-mono text-[10px] text-slate-300 bg-slate-950 p-2.5 rounded-lg border border-slate-900 whitespace-pre-wrap break-all select-text">
            {fix!.evidence}
          </pre>
        </div>
      )}

      <div>
        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-1">
          Suggested remediation
        </p>
        <pre className="font-mono text-[10px] text-emerald-200/90 bg-slate-950 p-2.5 rounded-lg border border-emerald-500/20 whitespace-pre-wrap break-all select-text">
          {fix!.remediationDiff}
        </pre>
      </div>

      {fix!.verificationSteps.length > 0 && (
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-1">
            How to verify the fix
          </p>
          <ol className="list-decimal ml-4 space-y-1">
            {fix!.verificationSteps.map((step, i) => (
              <li key={i} className="text-[11px] text-slate-300 leading-relaxed select-text">
                {step}
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="text-[9px] text-slate-600 font-mono leading-relaxed border-t border-slate-900 pt-2">
        Generated from static analysis — not executed or tested. Not exhaustive:
        one finding only, not a certification. No effort estimates in v1.
      </p>
    </div>
  );
}
