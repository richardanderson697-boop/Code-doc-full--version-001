// Workspace project intelligence report: stats, rubric, file ledger,
// application map, and missing-feature checklist.
import { useState } from "react";
import { Activity, AlertCircle, Brain, Check, CheckCircle2, CheckSquare, Copy, FileCode, FileWarning, Files, Network, Search } from "lucide-react";

import PreFlightFindingsPanel from "./PreFlightFindingsPanel";
import AstVoiceSummaryCard from "../AstVoiceSummaryCard";
import VoiceReadoutButton from "../VoiceReadoutButton";

interface IntelligenceReportProps {
  intelResult: any;
  onAuditFile: (filePath: string) => void;
}

export default function IntelligenceReport({ intelResult, onAuditFile }: IntelligenceReportProps) {
  const [intelReportCopied, setIntelReportCopied] = useState(false);
  const [fileLedgerSearch, setFileLedgerSearch] = useState("");
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const handleCopyIntelReport = () => {
    if (!intelResult) return;
    let text = `=== WORKSPACE PROJECT INTELLIGENCE REPORT ===\n\n`;
    text += `TOTAL FILES: ${intelResult.totalFiles}\n`;
    text += `TOTAL LINES OF CODE: ${intelResult.totalLines}\n\n`;
    text += `## OVERALL SUMMARY\n${intelResult.overallSummary}\n\n`;
    text += `## COMPLETENESS SCORE: ${intelResult.completenessScore}/100\n\n`;
    text += `## FILE LEDGER\n`;
    intelResult.fileLedger.forEach((f: any) => {
      text += `- ${f.filePath} (${f.lineCount} lines):\n  ↳ Description: ${f.description}\n  ↳ Contribution: ${f.contribution}\n\n`;
    });
    text += `## APPLICATION MAP\n`;
    text += `Entrypoint: ${intelResult.applicationMap?.entrypoint || "Not identified"}\n\n`;
    text += `Frontend Components:\n`;
    intelResult.applicationMap?.components?.forEach((c: any) => {
      text += `- ${c.name} (${c.filePath}): imports [${c.imports?.join(", ") || ""}]\n`;
    });
    text += `\nBackend API Endpoints:\n`;
    intelResult.applicationMap?.endpoints?.forEach((e: any) => {
      text += `- [${e.method}] ${e.path}: ${e.purpose}\n`;
    });
    text += `\n## INTENDED / MISSING PRODUCTION FEATURES\n`;
    intelResult.missingFeatures?.forEach((m: any) => {
      text += `- [${m.category}] ${m.feature}: ${m.reason}\n`;
    });

    navigator.clipboard.writeText(text);
    setIntelReportCopied(true);
    setTimeout(() => setIntelReportCopied(false), 2000);
  };

  return (
              intelResult.notEnoughFiles ? (
                <div className="flex flex-col items-center justify-center p-8 text-center bg-slate-950/40 border border-amber-500/15 rounded-xl space-y-4 select-text animate-fadeIn">
                  <div className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-full">
                    <FileWarning className="w-8 h-8" />
                  </div>
                  <div className="max-w-md space-y-2">
                    <h5 className="text-sm font-semibold text-amber-400 font-sans">
                      No Custom Codebase Detected
                    </h5>
                    <p className="text-xs text-slate-300 font-sans leading-relaxed">
                      {intelResult.error || "Not enough files to run scan on your codebase. Or upload more files to get a total scoring analysis?"}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 pt-2 animate-fadeIn">
                
                {/* Header copy action */}
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5 select-none">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                    <span className="text-[10px] uppercase font-bold tracking-wider text-indigo-300 font-mono flex items-center gap-1">
                      <Brain className="w-3.5 h-3.5 animate-pulse" /> Workspace Project Map Active
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyIntelReport}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-805/60 hover:bg-slate-800 text-slate-300 hover:text-slate-100 rounded-lg text-xs font-medium border border-slate-800/80 transition duration-150 shadow-xs cursor-pointer"
                  >
                    {intelReportCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400 font-mono text-[10px]">Copied Workspace Report!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span className="font-mono text-[10px]">Copy Workspace Ledger</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Workspace Stats Widget */}
                <div className="grid grid-cols-3 gap-2.5 bg-slate-950/80 border border-slate-850 p-3.5 rounded-xl select-none">
                  <div className="text-center p-2 rounded-lg bg-slate-900/40 border border-slate-900">
                    <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider font-sans">Total Files</span>
                    <span className="text-lg font-bold font-mono text-slate-200 mt-0.5 block">{intelResult.totalFiles}</span>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-slate-900/40 border border-slate-900">
                    <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider font-sans">Total Lines</span>
                    <span className="text-lg font-bold font-mono text-slate-200 mt-0.5 block">{intelResult.totalLines}</span>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-slate-900/40 border border-slate-900">
                    <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider font-sans">Overall Grade</span>
                    <span className={`text-lg font-bold font-mono mt-0.5 block ${
                      intelResult.completenessScore >= 80 ? "text-emerald-400" : intelResult.completenessScore >= 50 ? "text-amber-400" : "text-rose-400"
                    }`}>{intelResult.completenessScore}/100</span>
                  </div>
                </div>

                {/* Audible AST score & flagged-issues voice summary */}
                <AstVoiceSummaryCard
                  completenessScore={intelResult.completenessScore ?? 0}
                  totalFiles={intelResult.totalFiles}
                  totalLines={intelResult.totalLines}
                  overallSummary={intelResult.overallSummary}
                  sanityChecks={intelResult.sanityChecks}
                  missingFeatures={intelResult.missingFeatures}
                  categoryScores={intelResult.categoryScores}
                />

                {/* Plain English Overall Summary */}
                <div className="bg-gradient-to-br from-indigo-950/15 to-slate-950/40 border border-indigo-500/15 rounded-xl p-4 space-y-2">
                  <div className="flex items-center gap-1.5 text-indigo-400 select-none">
                    <Activity className="w-4 h-4" />
                    <h5 className="text-[10px] uppercase font-bold tracking-wider font-sans">
                      Accumulated Application Summary
                    </h5>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed font-sans select-text whitespace-pre-wrap">
                    {intelResult.overallSummary}
                  </p>
                </div>

                {/* PreFlight Deterministic Findings */}
                {intelResult.preflight && <PreFlightFindingsPanel report={intelResult.preflight} />}

                {/* Completeness Evaluation Rubric Progress Card */}
                {intelResult.completenessScore !== undefined && (
                  <div className="bg-gradient-to-br from-slate-950 to-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
                    <div className="flex items-center justify-between select-none">
                      <div>
                        <h5 className="text-[10px] uppercase font-bold tracking-wider text-indigo-400 font-sans">
                          Completeness Evaluation Rubric
                        </h5>
                        <p className="text-slate-500 text-[10px] mt-0.5 leading-tight">
                          Evaluated across the entire workspace (Backend server, Frontend logic, APIs, and layouts combined)
                        </p>
                      </div>
                      <div className="flex flex-col items-end">
                        <span className={`text-xl font-bold font-mono tracking-tight ${
                          intelResult.completenessScore >= 80 ? "text-emerald-400" : intelResult.completenessScore >= 50 ? "text-amber-400" : "text-rose-400"
                        }`}>{intelResult.completenessScore}/100</span>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="space-y-1.5 select-none">
                      <div className="relative h-2.5 w-full bg-slate-900 rounded-full overflow-hidden border border-slate-800/60 p-[1px]">
                        <div 
                          className={`h-full rounded-full transition-all duration-500 ${
                            intelResult.completenessScore >= 80 
                              ? "bg-gradient-to-r from-emerald-500 to-teal-400" 
                              : intelResult.completenessScore >= 50 
                              ? "bg-gradient-to-r from-amber-500 to-orange-400" 
                              : "bg-gradient-to-r from-rose-500 to-red-400"
                          }`}
                          style={{ width: `${intelResult.completenessScore}%` }}
                        />
                        <div className="absolute top-0 bottom-0 left-1/2 w-[1px] bg-slate-800/80 pointer-events-none" />
                      </div>
                      <div className="flex justify-between text-[9px] text-slate-500 font-mono">
                        <span>0% (Empty Shell)</span>
                        <span className="text-slate-400 font-semibold">50% (Max UI Shell Threshold)</span>
                        <span>100% (Production Ready)</span>
                      </div>
                    </div>

                    {/* Collapsible Rubric List */}
                    {intelResult.categoryScores && (
                      <div className="mt-4 pt-3 border-t border-slate-850 space-y-2">
                        <div className="flex items-center justify-between text-[10px] uppercase font-bold tracking-wider text-slate-400 font-mono mb-1 select-none">
                          <span>Verified Category Scores</span>
                        </div>
                        <div className="divide-y divide-slate-850 border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40">
                          {[
                            { key: "serverStarts", label: "Server starts correctly", val: intelResult.categoryScores.serverStarts },
                            { key: "authentication", label: "Authentication implemented", val: intelResult.categoryScores.authentication },
                            { key: "databaseLayer", label: "Database layer", val: intelResult.categoryScores.databaseLayer },
                            { key: "errorHandling", label: "Error handling", val: intelResult.categoryScores.errorHandling },
                            { key: "coreLogic", label: "Core business / domain logic", val: intelResult.categoryScores.coreLogic },
                            { key: "backgroundAutomation", label: "Background automation", val: intelResult.categoryScores.backgroundAutomation },
                            { key: "externalIntegrations", label: "External integrations", val: intelResult.categoryScores.externalIntegrations },
                            { key: "security", label: "Security", val: intelResult.categoryScores.security },
                            { key: "performance", label: "Performance", val: intelResult.categoryScores.performance },
                            { key: "documentationVerified", label: "Documentation / verified", val: intelResult.categoryScores.documentationVerified }
                          ].map((item, idx) => {
                            const val = item.val || { score: 10, max: 10, reason: "Not required/applicable for this application's design scope" };
                            const isExpanded = expandedCategory === `intel_${item.key}`;
                            return (
                              <div key={item.key} className="flex flex-col transition-colors">
                                <button
                                  type="button"
                                  onClick={() => setExpandedCategory(isExpanded ? null : `intel_${item.key}`)}
                                  className={`w-full flex items-center justify-between px-3 py-2 text-left hover:bg-slate-900/60 transition duration-100 font-sans text-xs text-slate-300 font-medium cursor-pointer ${
                                    isExpanded ? "bg-slate-900/30" : ""
                                  }`}
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-slate-600 font-mono font-bold">
                                      {(idx + 1).toString().padStart(2, '0')}
                                    </span>
                                    <span className="font-sans font-semibold text-slate-200">
                                      {item.label}
                                    </span>
                                    <span className="text-[9px] text-slate-500 font-mono">
                                      {isExpanded ? "▲ Hide" : "▼ Explain"}
                                    </span>
                                  </div>
                                  
                                  <div className="flex items-center gap-6 font-mono font-semibold">
                                    <span className="text-slate-500 w-6 text-right">{val.max}</span>
                                    <span className={`w-8 text-right font-bold ${
                                      val.score >= 8 ? "text-emerald-400" : val.score >= 5 ? "text-amber-400" : "text-rose-400"
                                    }`}>{val.score}</span>
                                  </div>
                                </button>
                                
                                {isExpanded && (
                                  <div className="px-3 pb-2.5 pt-0.5 bg-slate-950/60 text-[10px] font-mono text-slate-400 leading-relaxed border-t border-slate-900/85">
                                    <div className="p-2 bg-slate-900/40 rounded border border-slate-850 mt-1.5 flex items-start justify-between gap-2">
                                      <div>💡 <span className="text-slate-300">{val.reason}</span></div>
                                      <VoiceReadoutButton title={`Rubric: ${item.label}`} textToSpeak={val.reason} size="icon" />
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* THE LEDGER: Workspace File Ledger */}
                <div className="bg-slate-950/40 border border-slate-800/80 rounded-xl overflow-hidden">
                  <div className="px-3.5 py-2.5 bg-slate-950/60 border-b border-slate-800/80 flex items-center justify-between select-none">
                    <div className="flex items-center gap-2">
                      <Files className="w-4 h-4 text-indigo-400" />
                      <h5 className="text-[10px] uppercase font-bold tracking-wider text-slate-300">
                        Workspace File Ledger
                      </h5>
                    </div>
                    <span className="text-[9px] text-indigo-400 font-mono font-bold">
                      {intelResult.fileLedger?.length || 0} TOTAL FILES
                    </span>
                  </div>

                  {/* Ledger Search Bar */}
                  <div className="p-2 bg-slate-950/50 border-b border-slate-850">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-500" />
                      <input
                        type="text"
                        placeholder="Search files in ledger..."
                        value={fileLedgerSearch}
                        onChange={(e) => setFileLedgerSearch(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800/80 rounded-lg py-1.5 pl-8 pr-3 text-[10px] font-mono text-slate-200 placeholder-slate-600 focus:outline-hidden focus:border-indigo-500/50"
                      />
                    </div>
                  </div>

                  {/* Ledger List */}
                  <div className="divide-y divide-slate-850 max-h-72 overflow-y-auto font-mono text-xs">
                    {intelResult.fileLedger ? (
                      intelResult.fileLedger
                        .filter((f: any) => f.filePath?.toLowerCase().includes(fileLedgerSearch.toLowerCase()))
                        .map((file: any, i: number) => (
                          <div key={i} className="p-3 hover:bg-slate-900/30 transition duration-100 flex flex-col gap-1.5 select-text">
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-xs font-mono font-bold text-indigo-300 break-all">{file.filePath}</span>
                              <div className="flex items-center gap-2 shrink-0 select-none">
                                <span className="text-[9px] font-mono text-slate-500 bg-slate-900 border border-slate-850 px-1.5 py-0.2 rounded-md shrink-0">
                                  {file.lineCount} lines
                                </span>
                                <button
                                  type="button"
                                  onClick={() => onAuditFile(file.filePath)}
                                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/20 hover:text-indigo-200 transition shrink-0 cursor-pointer"
                                  title={`Inspect and run Step 1 evidence check on "${file.filePath}"`}
                                >
                                  <FileCode className="w-2.5 h-2.5" />
                                  <span>Audit File</span>
                                </button>
                              </div>
                            </div>
                            <p className="text-[10px] text-slate-400 leading-normal font-sans">
                              <strong>Business Purpose:</strong> {file.description}
                            </p>
                            <p className="text-[10px] text-slate-500 leading-normal font-sans border-l border-indigo-500/20 pl-2 mt-0.5">
                              <strong>Accumulation Value:</strong> {file.contribution}
                            </p>
                          </div>
                        ))
                    ) : (
                      <div className="p-4 text-center text-[11px] text-slate-600 italic">No files in workspace ledger.</div>
                    )}
                  </div>
                </div>

                {/* Application Structure Map */}
                {intelResult.applicationMap && (
                  <div className="bg-slate-950/40 border border-slate-800/80 rounded-xl overflow-hidden">
                    <div className="px-3.5 py-2.5 bg-slate-950/60 border-b border-slate-800/80 flex items-center gap-2 select-none">
                      <Network className="w-4 h-4 text-indigo-400" />
                      <h5 className="text-[10px] uppercase font-bold tracking-wider text-slate-300">
                        Application Architecture Map
                      </h5>
                    </div>

                    <div className="p-3.5 space-y-3">
                      <div className="text-[10px] font-mono text-slate-400 select-text">
                        <strong className="text-slate-300">Main Entrypoint:</strong>{" "}
                        <span className="text-indigo-300 font-bold bg-slate-900 border border-slate-850 px-1.5 py-0.5 rounded">
                          {intelResult.applicationMap.entrypoint || "src/main.tsx"}
                        </span>
                      </div>

                      {/* Backend endpoints */}
                      {intelResult.applicationMap.endpoints && intelResult.applicationMap.endpoints.length > 0 && (
                        <div className="space-y-1.5 pt-1.5 font-mono text-xs">
                          <span className="text-[9px] uppercase font-bold tracking-widest text-slate-500 block select-none">Backend API Routes</span>
                          <div className="space-y-1.5">
                            {intelResult.applicationMap.endpoints.map((ep: any, i: number) => (
                              <div key={i} className="p-2 bg-slate-900/40 border border-slate-850 rounded-lg text-xs font-mono select-text">
                                <div className="flex items-center gap-2">
                                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.2 rounded shrink-0 ${
                                    ep.method?.toUpperCase() === "GET" ? "bg-emerald-500/10 text-emerald-400" : "bg-indigo-500/10 text-indigo-400"
                                  }`}>{ep.method || "GET"}</span>
                                  <span className="text-indigo-200 font-bold break-all">{ep.path}</span>
                                </div>
                                <span className="block text-[10px] text-slate-400 font-sans mt-1 leading-normal pl-1 border-l border-indigo-500/10">
                                  {ep.purpose}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Frontend components */}
                      {intelResult.applicationMap.components && intelResult.applicationMap.components.length > 0 && (
                        <div className="space-y-1.5 pt-1.5 font-mono text-xs">
                          <span className="text-[9px] uppercase font-bold tracking-widest text-slate-500 block select-none">Frontend React Components</span>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                            {intelResult.applicationMap.components.map((c: any, i: number) => (
                              <div key={i} className="p-2 bg-slate-900/20 border border-slate-850/80 rounded-lg text-[10px] font-mono select-text">
                                <span className="text-indigo-300 font-bold block">{c.name}</span>
                                <span className="text-[8px] text-slate-500 block mt-0.5 truncate">{c.filePath}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Gaps / Intended but Missing Features Checklist */}
                <div className="bg-slate-950/40 border border-slate-800/80 rounded-xl overflow-hidden">
                  <div className="px-3.5 py-2.5 bg-slate-950/60 border-b border-slate-800/80 flex items-center gap-2 select-none">
                    <CheckSquare className="w-4 h-4 text-amber-400" />
                    <h5 className="text-[10px] uppercase font-bold tracking-wider text-slate-300">
                      Intended & Missing Production Features
                    </h5>
                  </div>
                  <div className="p-3.5 space-y-2.5">
                    {intelResult.missingFeatures && intelResult.missingFeatures.length > 0 ? (
                      intelResult.missingFeatures.map((m: any, i: number) => (
                        <div key={i} className="p-2.5 bg-slate-900/40 border border-slate-850 rounded-lg text-xs flex gap-2.5 select-text">
                          <div className="p-1 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0 h-fit select-none">
                            <AlertCircle className="w-3.5 h-3.5" />
                          </div>
                          <div>
                            <span className="font-semibold text-slate-200 block font-sans leading-snug">{m.feature}</span>
                            <span className="text-slate-500 text-[9px] uppercase font-mono tracking-wider font-bold block mt-0.5">{m.category} Module</span>
                            <p className="text-slate-400 text-[10px] font-sans mt-1 leading-normal">{m.reason}</p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="p-3.5 bg-emerald-500/5 border border-emerald-500/10 rounded-xl flex items-center gap-2 select-none">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span className="text-[11px] text-emerald-400 font-sans">Every single feature across the workspace is fully coded and verified production-ready!</span>
                      </div>
                    )}
                  </div>
                </div>

              </div>
              )
  );
}
