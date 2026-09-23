// Deterministic findings panel. Renders the PreFlight report attached to
// cold-audit / project-intelligence responses: line-anchored, probe-verified
// findings with no LLM judgment involved.
import { useState } from "react";
import { ShieldCheck, ShieldAlert, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import VoiceReadoutButton from "../VoiceReadoutButton";
import type { PreFlightReport, PreFlightFinding } from "../../../shared/preflight-types";
import { isScanIncomplete } from "../../../shared/preflight-types";

interface PreFlightFindingsPanelProps {
  report: PreFlightReport;
}

const SEVERITY_ORDER: PreFlightFinding["severity"][] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_STYLES: Record<PreFlightFinding["severity"], string> = {
  critical: "bg-rose-500/15 border-rose-500/30 text-rose-300",
  high: "bg-rose-500/10 border-rose-500/20 text-rose-400",
  medium: "bg-amber-500/10 border-amber-500/20 text-amber-400",
  low: "bg-sky-500/10 border-sky-500/20 text-sky-400",
  info: "bg-slate-500/10 border-slate-500/20 text-slate-400",
};

export default function PreFlightFindingsPanel({ report }: PreFlightFindingsPanelProps) {
  const [expanded, setExpanded] = useState<number | null>(null);

  const ordered = SEVERITY_ORDER.flatMap((sev) => report.findings.filter((f) => f.severity === sev));
  const severitySummary = SEVERITY_ORDER.filter((sev) => report.counts[sev]).map(
    (sev) => `${report.counts[sev]} ${sev}`
  ).join(" · ");
  // A scan that failed, lost probes, or skipped files cannot support a
  // "nothing found" claim. Say "not measured" instead of implying clean.
  const incomplete = isScanIncomplete(report);

  return (
    <div className="bg-slate-950/40 border border-slate-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-950/70 border-b border-slate-800 select-none">
        <div className="flex items-center gap-2">
          <div
            className={`p-1.5 rounded-lg border ${
              incomplete
                ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
            }`}
          >
            {incomplete ? <ShieldAlert className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
          </div>
          <div>
            <h5 className="text-[10px] uppercase font-bold tracking-wider text-slate-200">
              PreFlight Deterministic Scan
            </h5>
            <p className="text-[9px] text-slate-500 font-mono">
              {report.probeCount} probes · {report.filesScanned} file{report.filesScanned === 1 ? "" : "s"} scanned
              {severitySummary ? ` · ${severitySummary}` : incomplete ? "" : " · no findings"}
            </p>
          </div>
        </div>
        {/* A score computed from an incomplete scan would read as a verdict it
            has not earned, so withhold it rather than show a reassuring number. */}
        {incomplete ? (
          <span
            className="text-[10px] font-mono font-bold px-2.5 py-1 rounded-lg border bg-amber-500/10 border-amber-500/20 text-amber-400"
            title="Scan did not cover everything, so no score is shown"
          >
            partial
          </span>
        ) : (
          <span
            className={`text-xs font-mono font-bold px-2.5 py-1 rounded-lg border ${
              report.score >= 90
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                : report.score >= 70
                ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                : "bg-rose-500/10 border-rose-500/20 text-rose-400"
            }`}
            title="PreFlight security score (deterministic, 0-100)"
          >
            {report.score}/100
          </span>
        )}
      </div>

      {/* Why the scan is partial: a failure, a dead probe, or skipped files. */}
      {incomplete && (
        <div className="px-4 py-2.5 bg-amber-500/5 border-b border-amber-500/15 space-y-1">
          {report.failed && (
            <p className="text-[10px] text-amber-300 font-mono leading-relaxed">{report.failed}</p>
          )}
          {report.probeFailures.length > 0 && (
            <p className="text-[10px] text-amber-300/90 font-mono leading-relaxed">
              {report.probeFailures.length} probe
              {report.probeFailures.length === 1 ? "" : "s"} failed:{" "}
              {report.probeFailures.map((p) => p.probe).join(", ")}
            </p>
          )}
          {report.filesSkipped.length > 0 && (
            <p className="text-[10px] text-amber-300/90 font-mono leading-relaxed">
              {report.filesSkipped.length} file
              {report.filesSkipped.length === 1 ? "" : "s"} not scanned:{" "}
              {report.filesSkipped
                .slice(0, 3)
                .map((s) => `${s.path} (${s.reason})`)
                .join("; ")}
              {report.filesSkipped.length > 3 ? ` and ${report.filesSkipped.length - 3} more` : ""}
            </p>
          )}
          <p className="text-[10px] text-amber-400/70 font-mono">
            Treat this as "not fully measured", not "clean".
          </p>
        </div>
      )}

      {/* Findings */}
      {ordered.length === 0 ? (
        <div className="p-4 text-center">
          <p className="text-xs text-slate-500 italic">
            {incomplete
              ? "No findings to show. The scan did not complete, so this is not a clean result."
              : "No deterministic findings. Every probe came back clean for the scanned scope."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-slate-900">
          {ordered.map((f, idx) => (
            <div key={idx} className="px-4 py-2.5">
              <button
                type="button"
                onClick={() => setExpanded(expanded === idx ? null : idx)}
                className="w-full flex items-center gap-2 text-left cursor-pointer group"
                aria-label={`Toggle details for finding: ${f.title}`}
              >
                {expanded === idx ? (
                  <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />
                )}
                <span
                  className={`text-[8px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border shrink-0 ${SEVERITY_STYLES[f.severity]}`}
                >
                  {f.severity}
                </span>
                <span className="text-xs text-slate-300 group-hover:text-slate-100 transition duration-100 flex-1 min-w-0 truncate">
                  {f.title}
                </span>
                <span className="text-[9px] font-mono text-slate-600 shrink-0">
                  {f.file}
                  {f.line ? `:${f.line}` : ""}
                </span>
              </button>
              {expanded === idx && (
                <div className="mt-2 ml-5 space-y-2">
                  <p className="text-[10px] font-mono text-slate-500">
                    Probe: {f.probe}
                    {f.cwe ? ` · ${f.cwe}` : ""}
                    {f.owasp?.length ? ` · OWASP ${f.owasp.join(", ")}` : ""}
                    {f.originalSeverity ? ` · engine reported "${f.originalSeverity}"` : ""}
                  </p>
                  {f.evidence && (
                    <pre className="font-mono text-[10px] text-slate-300 bg-slate-950 p-2.5 rounded-lg border border-slate-900 whitespace-pre-wrap break-all select-text">
                      {f.evidence}
                    </pre>
                  )}
                  {f.remediation && (
                    <p className="text-[11px] text-slate-400 leading-relaxed bg-slate-900/30 p-2.5 rounded-lg border border-slate-900/60 whitespace-pre-wrap select-text">
                      {f.remediation}
                    </p>
                  )}
                  <div className="flex justify-end">
                    <VoiceReadoutButton
                      title={`PreFlight ${f.severity} finding: ${f.title}`}
                      textToSpeak={f.remediation || f.title}
                      label="Read Finding"
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Attribution */}
      <div className="px-4 py-2 bg-slate-950/70 border-t border-slate-800 flex items-center justify-between select-none">
        <span className="text-[9px] text-slate-600 font-mono">
          Deterministic findings by PreFlight. Free in-browser code audit.
        </span>
        <a
          href="https://preflight.midatlantic.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[9px] font-mono text-emerald-500/80 hover:text-emerald-400 flex items-center gap-1 transition duration-100"
        >
          preflight.midatlantic.ai
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
      </div>
    </div>
  );
}
