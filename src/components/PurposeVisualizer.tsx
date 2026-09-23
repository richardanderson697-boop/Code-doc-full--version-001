import React, { useState, useMemo } from "react";
import { 
  BookOpen, 
  Map, 
  Settings, 
  Play, 
  Palette, 
  ArrowRight, 
  Save, 
  Download, 
  AlertTriangle, 
  Sparkles, 
  Activity, 
  RefreshCw 
} from "lucide-react";
import VoiceReadoutButton from "./VoiceReadoutButton";

interface PurposeVisualizerProps {
  purpose: string;
  isGenerating: boolean;
  onDownloadNotes: () => void;
  onTriggerAudit?: () => void;
  isAuditing?: boolean;
}

export default function PurposeVisualizer({ 
  purpose, 
  isGenerating, 
  onDownloadNotes,
  onTriggerAudit,
  isAuditing = false
}: PurposeVisualizerProps) {
  const [viewMode, setViewMode] = useState<"visual" | "text">("visual");

  // Inline formatting helper for bold (**text**) and code (`text`) in strings
  const renderInlineStyles = (txt: string) => {
    if (!txt) return null;
    const parts = txt.split(/(\*\*.*?\*\*|`.*?`)/);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i} className="font-semibold text-emerald-400">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={i} className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-amber-300 font-mono text-xs">{part.slice(1, -1)}</code>;
      }
      return part;
    });
  };

  // Custom high-quality markdown parser for full-text notes
  const renderMarkdown = useMemo(() => {
    if (!purpose) return <div className="text-slate-500 italic text-xs">Waiting for explanations to develop...</div>;

    const lines = purpose.split("\n");
    const elements: React.ReactNode[] = [];
    let currentList: string[] = [];
    let inList = false;

    const flushList = (keyIndex: number) => {
      if (currentList.length > 0) {
        elements.push(
          <ul key={`list-${keyIndex}`} className="list-disc pl-5 space-y-2 my-2 text-slate-300 text-xs">
            {currentList.map((item, idx) => (
              <li key={idx} className="leading-relaxed">{renderInlineStyles(item)}</li>
            ))}
          </ul>
        );
        currentList = [];
        inList = false;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        if (inList) flushList(i);
        continue;
      }

      // Title (#)
      if (line.startsWith("# ")) {
        if (inList) flushList(i);
        elements.push(
          <h3 key={i} className="text-sm font-semibold tracking-wider uppercase text-slate-400 border-b border-slate-800 pb-2 mt-5 mb-3">
            {renderInlineStyles(line.slice(2))}
          </h3>
        );
      }
      // Subtitle (##)
      else if (line.startsWith("## ")) {
        if (inList) flushList(i);
        elements.push(
          <h4 key={i} className="text-sm font-medium text-emerald-400 mt-4 mb-2">
            {renderInlineStyles(line.slice(3))}
          </h4>
        );
      }
      // Triple Subtitle (###)
      else if (line.startsWith("### ")) {
        if (inList) flushList(i);
        elements.push(
          <h5 key={i} className="text-xs font-semibold text-slate-200 mt-3 mb-1">
            {renderInlineStyles(line.slice(4))}
          </h5>
        );
      }
      // Bullets (- or *)
      else if (line.startsWith("- ") || line.startsWith("* ")) {
        inList = true;
        currentList.push(line.slice(2));
      }
      // Numbered items
      else if (/^\d+\.\s/.test(line)) {
        inList = true;
        currentList.push(line.replace(/^\d+\.\s/, ""));
      }
      // Paragraph
      else {
        if (inList) flushList(i);
        elements.push(
          <p key={i} className="text-slate-300 leading-relaxed text-xs my-2">
            {renderInlineStyles(line)}
          </p>
        );
      }
    }

    if (inList) flushList(lines.length);
    return <div className="space-y-2">{elements}</div>;
  }, [purpose]);

  // Extract structured modules for visual blueprint view
  const blueprintData = useMemo(() => {
    const data = {
      overview: "",
      states: [] as { name: string; purpose: string }[],
      functions: [] as { name: string; purpose: string }[],
      styling: [] as string[],
      gaps: [] as string[],
    };

    if (!purpose) return data;

    const lines = purpose.split("\n");
    let section: "none" | "overview" | "states" | "functions" | "styling" | "gaps" = "none";

    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line) continue;

      const lower = line.toLowerCase();
      if (lower.startsWith("#") && (lower.includes("completeness") || lower.includes("health") || lower.includes("audit"))) {
        section = "overview";
        continue;
      } else if (lower.includes("architecture overview") || (lower.startsWith("#") && lower.includes("overview"))) {
        section = "overview";
        continue;
      } else if (lower.startsWith("#") && (lower.includes("placeholder") || lower.includes("gaps") || lower.includes("missing"))) {
        section = "gaps";
        continue;
      } else if (lower.includes("state") || lower.includes("hooks") || (lower.startsWith("#") && lower.includes("state"))) {
        section = "states";
        continue;
      } else if (lower.includes("function") || (lower.startsWith("#") && lower.includes("function")) || lower.includes("active features")) {
        section = "functions";
        continue;
      } else if (lower.includes("styling") || lower.includes("visual") || (lower.startsWith("#") && lower.includes("style"))) {
        section = "styling";
        continue;
      }

      if (section === "overview") {
        if (line.startsWith("- ") || line.startsWith("* ")) {
          data.overview += (data.overview ? "\n" : "") + "• " + line.slice(2);
        } else if (!line.startsWith("#")) {
          data.overview += (data.overview ? "\n" : "") + line;
        }
      } else if (section === "gaps") {
        if (line.startsWith("- ") || line.startsWith("* ")) {
          data.gaps.push(line.slice(2));
        } else if (!line.startsWith("#")) {
          data.gaps.push(line);
        }
      } else if (section === "states") {
        const match = line.match(/^[-*]\s+\*\*(.*?)\*\*:\s*(.*)/);
        if (match) {
          data.states.push({ name: match[1], purpose: match[2] });
        } else if (line.startsWith("- ") || line.startsWith("* ")) {
          // Simple bullet points
          const inlineText = line.slice(2);
          const splitPt = inlineText.indexOf(":");
          if (splitPt !== -1) {
            data.states.push({
              name: inlineText.substring(0, splitPt).replace(/\*\*/g, ""),
              purpose: inlineText.substring(splitPt + 1).trim(),
            });
          } else {
            data.states.push({ name: "Hook/State", purpose: inlineText });
          }
        }
      } else if (section === "functions") {
        const match = line.match(/^[-*]\s+\*\*(.*?)\*\*:\s*(.*)/);
        if (match) {
          data.functions.push({ name: match[1], purpose: match[2] });
        } else if (line.startsWith("- ") || line.startsWith("* ")) {
          const inlineText = line.slice(2);
          const splitPt = inlineText.indexOf(":");
          if (splitPt !== -1) {
            data.functions.push({
              name: inlineText.substring(0, splitPt).replace(/\*\*/g, ""),
              purpose: inlineText.substring(splitPt + 1).trim(),
            });
          } else {
            data.functions.push({ name: "Handler", purpose: inlineText });
          }
        }
      } else if (section === "styling") {
        if (line.startsWith("- ") || line.startsWith("* ")) {
          data.styling.push(line.slice(2));
        } else if (!line.startsWith("#")) {
          data.styling.push(line);
        }
      }
    }

    return data;
  }, [purpose]);

  const hasBlueprintContent = blueprintData.overview || blueprintData.states.length > 0 || blueprintData.functions.length > 0 || blueprintData.gaps.length > 0;

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden h-full flex-1">
      {/* Header controls */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-900/60 border-b border-slate-800">
        <div className="flex items-center gap-2">
          {viewMode === "visual" ? (
            <Map className="w-4 h-4 text-emerald-400" />
          ) : (
            <BookOpen className="w-4 h-4 text-emerald-400" />
          )}
          <span className="text-xs font-semibold text-slate-200">
            {viewMode === "visual" ? "Architecture Map" : "Structural Documentation"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onTriggerAudit && (
            <button
              onClick={onTriggerAudit}
              disabled={isAuditing || isGenerating}
              className={`px-2 py-1.5 rounded transition duration-150 flex items-center gap-1.5 text-xs font-medium border ${
                isAuditing
                  ? "bg-amber-500/10 border-amber-500/30 text-amber-400 animate-pulse"
                  : "bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-300 hover:text-slate-100"
              }`}
              title="Audit actual code completeness"
            >
              {isAuditing ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-400" />
                  <span className="text-[10px]">Auditing...</span>
                </>
              ) : (
                <>
                  <Activity className="w-3.5 h-3.5 text-rose-400" />
                  <span className="text-[10px]">Audit Code</span>
                </>
              )}
            </button>
          )}

          <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
            <button
              onClick={() => setViewMode("visual")}
              className={`px-2 py-1 rounded text-[10px] font-medium transition duration-150 flex items-center gap-1 ${
                viewMode === "visual"
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Map className="w-3 h-3" /> Map
            </button>
            <button
              onClick={() => setViewMode("text")}
              className={`px-2 py-1 rounded text-[10px] font-medium transition duration-150 flex items-center gap-1 ${
                viewMode === "text"
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <BookOpen className="w-3 h-3" /> Notes
            </button>
          </div>
          <button
            onClick={onDownloadNotes}
            disabled={!purpose}
            className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition duration-150 disabled:opacity-50"
            title="Download Notes"
            aria-label="Download blueprint notes"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Panel Content */}
      <div className="flex-1 overflow-auto p-5 space-y-4">
        {isGenerating && !purpose && (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 py-12">
            <span className="text-xs animate-pulse">Decompressing structural blueprints...</span>
          </div>
        )}

        {!purpose && !isGenerating && (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 py-12">
            <span className="text-xs">Waiting for explanations to develop...</span>
          </div>
        )}

        {purpose && (
          <>
            {viewMode === "visual" && hasBlueprintContent ? (
              <div className="space-y-4">
                {/* 0. Gaps, Placeholders, Missing Logic Warning Box */}
                {blueprintData.gaps.length > 0 && (
                  <div className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl relative overflow-hidden group hover:border-amber-500/30 transition duration-200">
                    <div className="absolute top-0 left-0 h-full w-1 bg-amber-500/50" />
                    <h5 className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-2 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 animate-pulse" /> Gaps & Missing Logic (Honest Audit)
                    </h5>
                    <ul className="space-y-1.5 text-slate-300 text-[11px] font-light">
                      {blueprintData.gaps.map((gap, i) => (
                        <li key={i} className="flex items-start gap-2 leading-relaxed">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 shrink-0" />
                          <span>{renderInlineStyles(gap)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* 1. Architecture Overview */}
                {blueprintData.overview && (
                  <div className="p-4 bg-slate-950/40 border border-slate-800/80 rounded-xl relative overflow-hidden group hover:border-slate-800 transition duration-200">
                    <div className="absolute top-0 left-0 h-full w-1 bg-emerald-500/40" />
                    <div className="flex items-center justify-between mb-1.5">
                      <h5 className="text-[10px] uppercase tracking-wider text-slate-400 font-bold flex items-center gap-1.5">
                        <Settings className="w-3.5 h-3.5 text-emerald-400" /> System Architecture
                      </h5>
                      <VoiceReadoutButton title="System Architecture Overview" textToSpeak={blueprintData.overview} label="Read Voice" />
                    </div>
                    <p className="text-slate-300 text-xs leading-relaxed font-light">
                      {blueprintData.overview}
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* 2. States / Reactive States */}
                  {blueprintData.states.length > 0 && (
                    <div className="p-4 bg-slate-950/40 border border-slate-800/80 rounded-xl relative overflow-hidden flex flex-col">
                      <div className="absolute top-0 left-0 h-full w-1 bg-amber-500/40" />
                      <h5 className="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-3 flex items-center gap-1.5">
                        <Palette className="w-3.5 h-3.5 text-amber-400" /> Reactive States & Hooks
                      </h5>
                      <div className="space-y-2.5 flex-1">
                        {blueprintData.states.map((st, i) => (
                          <div key={i} className="bg-slate-900/60 rounded p-2.5 border border-slate-800/50">
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-mono text-xs text-amber-300 font-medium">
                                {st.name}
                              </span>
                              <VoiceReadoutButton title={`State hook ${st.name}`} textToSpeak={st.purpose} size="icon" />
                            </div>
                            <p className="text-slate-300 text-[11px] leading-relaxed">
                              {renderInlineStyles(st.purpose)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 3. Core Functions */}
                  {blueprintData.functions.length > 0 && (
                    <div className="p-4 bg-slate-950/40 border border-slate-800/80 rounded-xl relative overflow-hidden flex flex-col">
                      <div className="absolute top-0 left-0 h-full w-1 bg-sky-500/40" />
                      <h5 className="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-3 flex items-center gap-1.5">
                        <Play className="w-3.5 h-3.5 text-sky-400" /> Executable Functions
                      </h5>
                      <div className="space-y-2.5 flex-1">
                        {blueprintData.functions.map((fn, i) => (
                          <div key={i} className="bg-slate-900/60 rounded p-2.5 border border-slate-800/50">
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-mono text-xs text-sky-300 font-medium">
                                {fn.name}
                              </span>
                              <VoiceReadoutButton title={`Executable function ${fn.name}`} textToSpeak={fn.purpose} size="icon" />
                            </div>
                            <p className="text-slate-300 text-[11px] leading-relaxed">
                              {renderInlineStyles(fn.purpose)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* 4. Styling & Layout */}
                {blueprintData.styling.length > 0 && (
                  <div className="p-4 bg-slate-950/40 border border-slate-800/80 rounded-xl relative overflow-hidden">
                    <div className="absolute top-0 left-0 h-full w-1 bg-purple-500/40" />
                    <h5 className="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-2 flex items-center gap-1.5">
                      <Palette className="w-3.5 h-3.5 text-purple-400" /> Interface & Layout Design
                    </h5>
                    <ul className="space-y-1.5 text-slate-300 text-[11px] font-light">
                      {blueprintData.styling.map((sty, i) => (
                        <li key={i} className="flex items-start gap-2 leading-relaxed">
                          <ArrowRight className="w-3 h-3 text-purple-400 mt-1 shrink-0" />
                          <span>{renderInlineStyles(sty)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              /* Fallback/Standard view */
              <div className="prose prose-invert max-w-none prose-sm">
                {renderMarkdown}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
