// Cold-read audit results: evidence checklist with copyable report.
import { useState } from "react";
import { AlertTriangle, Check, Copy, ListChecks } from "lucide-react";
import { AuditResult } from "./types";
import PreFlightFindingsPanel from "./PreFlightFindingsPanel";
import VoiceReadoutButton from "../VoiceReadoutButton";

interface ColdReadResultsProps {
  result: AuditResult;
  onLineClick: (lines: string) => void;
}

export default function ColdReadResults({ result, onLineClick }: ColdReadResultsProps) {
  const [reportCopied, setReportCopied] = useState(false);

  const handleCopyReport = () => {
    if (!result) return;
    
    let text = `=== STEP 1 — FILE EVIDENCE EXTRACTOR ===\n`;
    text += `Target File: ${result.fileName || "N/A"}\n\n`;
    
    if (result.truncated) {
      text += `⚠️ [ALERT] File Appears Truncated: This code terminates abruptly mid-expression or is missing standard structural declarations.\n\n`;
    }

    text += `## IMMUTABLE FACTS & EVIDENCE DETECTED:\n\n`;
    if (result.evidence && result.evidence.length > 0) {
      result.evidence.forEach((item, idx) => {
        text += `Finding #${idx + 1}:\n`;
        text += `- Lines: ${item.lines || "N/A"}\n`;
        text += `- Confidence: ${item.confidence || "High"}\n`;
        text += `- Code Snippet:\n\`\`\`\n${item.codeSnippet || ""}\n\`\`\`\n`;
        text += `- Conclusion: ${item.conclusion || ""}\n\n`;
      });
    } else {
      text += `No evidence items found in this file.\n`;
    }

    navigator.clipboard.writeText(text);
    setReportCopied(true);
    setTimeout(() => setReportCopied(false), 2000);
  };

  return (
              <div className="space-y-4 pt-2">
                
                {/* Audit Report Header & Action */}
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">
                      Step 1 Evidence Extracted
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyReport}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-850/60 hover:bg-slate-800 text-slate-300 hover:text-slate-100 rounded-lg text-xs font-medium border border-slate-800/80 transition duration-150 shadow-xs cursor-pointer"
                  >
                    {reportCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400 font-mono text-[10px]">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span className="font-mono text-[10px]">Copy Evidence Report</span>
                      </>
                    )}
                  </button>
                </div>
                
                {/* Truncated Alert */}
                {result.truncated && (
                  <div className="flex items-start gap-3 border border-amber-500/20 bg-amber-500/5 rounded-xl p-4 relative overflow-hidden">
                    <div className="absolute top-0 left-0 h-full w-1 bg-amber-500/50" />
                    <AlertTriangle className="text-amber-400 flex-shrink-0 w-4.5 h-4.5 mt-0.5 animate-pulse" />
                    <div className="text-xs text-amber-300 font-sans leading-relaxed">
                      <strong className="text-amber-400 font-semibold block mb-0.5">FILE APPEARS TRUNCATED!</strong> 
                      This code terminates abruptly mid-expression or is missing standard structural declarations.
                    </div>
                  </div>
                )}

                {/* Analyzed File Name Info */}
                <div className="bg-slate-950/40 border border-slate-800/60 rounded-xl p-3 flex items-center justify-between">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Analyzed File</span>
                  <span className="text-xs font-mono font-bold text-slate-200 bg-slate-900 border border-slate-850 px-2 py-0.5 rounded-md">
                    {result.fileName || "Active Workspace Code"}
                  </span>
                </div>

                {/* PreFlight Deterministic Findings */}
                {result.preflight && <PreFlightFindingsPanel report={result.preflight} />}

                {/* Evidence Items Checklist */}
                <div className="space-y-3">
                  <div className="flex items-center gap-1.5 px-1 select-none">
                    <ListChecks className="w-4 h-4 text-rose-400" />
                    <h5 className="text-[10px] uppercase font-bold tracking-wider text-slate-300">
                      Line-by-Line File Findings
                    </h5>
                  </div>

                  {result.evidence && result.evidence.length > 0 ? (
                    <div className="space-y-4">
                      {result.evidence.map((item, idx) => (
                        <div 
                          key={idx}
                          className="bg-slate-950/50 border border-slate-800 rounded-xl p-4 space-y-3 hover:border-slate-700/60 transition duration-150 relative overflow-hidden"
                        >
                          {/* Finding Header */}
                          <div className="flex items-center justify-between border-b border-slate-900 pb-2">
                            <button
                              type="button"
                              onClick={() => onLineClick(item.lines)}
                              className="text-[10px] font-mono font-bold text-slate-400 hover:text-rose-400 flex items-center gap-1.5 bg-slate-900 border border-slate-850 px-2 py-0.5 rounded hover:border-rose-950 transition cursor-pointer"
                              title="Locate and highlight these lines in editor"
                            >
                              <span>Evidence: Lines {item.lines}</span>
                              <span className="text-[8px] text-slate-600">click to locate</span>
                            </button>
                            
                            <div className="flex items-center gap-2">
                              <VoiceReadoutButton 
                                title={`Finding on lines ${item.lines}`} 
                                textToSpeak={item.conclusion} 
                                label="Read Finding"
                              />
                              <span className={`text-[9px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                                item.confidence === "High" 
                                  ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                                  : item.confidence === "Medium"
                                  ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                                  : "bg-rose-500/10 border-rose-500/20 text-rose-400 animate-pulse"
                              }`}>
                                {item.confidence} Confidence
                              </span>
                            </div>
                          </div>

                          {/* Code Block */}
                          {item.codeSnippet && (
                            <div className="space-y-1">
                              <span className="text-[9px] uppercase font-bold tracking-widest text-slate-600 font-mono block select-none">Code Snippet</span>
                              <pre 
                                onClick={() => onLineClick(item.lines)}
                                className="font-mono text-[10px] text-slate-300 bg-slate-950 p-3 rounded-lg border border-slate-900 whitespace-pre-wrap select-text break-all cursor-pointer hover:border-slate-800 hover:text-slate-200 transition duration-100"
                                title="Click to focus lines"
                              >
                                {item.codeSnippet}
                              </pre>
                            </div>
                          )}

                          {/* Conclusion / Business Terms */}
                          <div className="space-y-1">
                            <span className="text-[9px] uppercase font-bold tracking-widest text-slate-600 font-mono block select-none">Conclusion / Functional Description</span>
                            <div className="text-xs text-slate-300 font-sans leading-relaxed bg-slate-900/30 p-3 rounded-lg border border-slate-900/60 select-text">
                              {item.conclusion}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-6 bg-slate-950/20 border border-slate-800 rounded-xl text-center select-none">
                      <p className="text-xs text-slate-500 italic">No evidence items extracted. This code is clean or unrecognized.</p>
                    </div>
                  )}
                </div>

              </div>
  );
}
