import React, { useMemo, useState } from "react";
import { apiFetch } from "../utils/apiFetch";
import { 
  Dna, 
  Layers, 
  HelpCircle, 
  ShieldAlert, 
  CheckCircle2, 
  ChevronRight, 
  Database, 
  RefreshCcw, 
  Zap, 
  PlayCircle,
  Sparkles,
  HeartPulse,
  HelpCircle as QuestionIcon
} from "lucide-react";
import { ReactAnatomy, ParsedState, ParsedEffect, ParsedHandler } from "../utils/anatomyParser";
import VoiceReadoutButton from "./VoiceReadoutButton";

interface AnatomyInspectorProps {
  anatomy: ReactAnatomy;
  code: string;
  onHighlightLine: (line: number) => void;
  highlightedLine: number | null;
  errorMessage?: string;
  originalPrompt?: string;
  onHealCode?: (healedCode: string) => void;
}

export default function AnatomyInspector({ 
  anatomy, 
  code, 
  onHighlightLine,
  highlightedLine,
  errorMessage = "",
  originalPrompt = "",
  onHealCode
}: AnatomyInspectorProps) {
  const [activeSubTab, setActiveSubTab] = useState<"states" | "effects" | "handlers" | "sanity">("states");
  const [isHealing, setIsHealing] = useState(false);
  const [healError, setHealError] = useState("");

  // Determine if stream is incomplete or truncated
  const streamInfo = useMemo(() => {
    if (!code || !code.trim()) return { isInterrupted: false, reason: "" };

    let openBraces = 0;
    let closeBraces = 0;
    for (const char of code) {
      if (char === "{") openBraces++;
      if (char === "}") closeBraces++;
    }

    const hasMismatchedBraces = openBraces > closeBraces;
    const isMissingExport = !code.includes("export default");
    const hasServiceError = errorMessage && (
      errorMessage.toLowerCase().includes("503") || 
      errorMessage.toLowerCase().includes("unavailable") || 
      errorMessage.toLowerCase().includes("demand") || 
      errorMessage.toLowerCase().includes("limit") ||
      errorMessage.toLowerCase().includes("apierror")
    );

    if (hasServiceError) {
      return { 
        isInterrupted: true, 
        reason: "The AI service encountered a temporary demand spike or rate limit and aborted the stream mid-way." 
      };
    }

    if (hasMismatchedBraces || isMissingExport) {
      return { 
        isInterrupted: true, 
        reason: "The component was cut-off before completing. It contains unclosed curly braces or is missing its default export." 
      };
    }

    return { isInterrupted: false, reason: "" };
  }, [code, errorMessage]);

  // Execute AI code healing
  const handleHealCode = async () => {
    if (!code || !code.trim() || isHealing) return;
    setIsHealing(true);
    setHealError("");

    try {
      const response = await apiFetch("/api/heal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          prompt: originalPrompt || "A fully functional React application"
        })
      });

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        const text = await response.text();
        throw new Error(`Server returned unexpected HTML/text response instead of JSON. The backend might still be initializing. Details: ${text.slice(0, 150)}...`);
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to trigger recovery compiler");
      }

      const data = await response.json();
      if (data.healedCode) {
        if (onHealCode) {
          onHealCode(data.healedCode);
        }
      } else {
        throw new Error("No healed code was returned from server");
      }
    } catch (err: any) {
      setHealError(err.message || "An error occurred while healing compiling structures.");
    } finally {
      setIsHealing(false);
    }
  };

  // 1. Interactive Vibe Code Sanity Check
  // Evaluates common react traps and describes them for a vibe coder
  const sanityChecks = useMemo(() => {
    const checks: {
      type: "success" | "warning" | "info" | "critical";
      title: string;
      message: string;
      line?: number;
      recommendation: string;
    }[] = [];

    if (!code || !code.trim()) return [];

    const lines = code.split("\n");

    // Add stream interrupted checks as a high-priority card
    if (streamInfo.isInterrupted) {
      checks.push({
        type: "critical",
        title: "API Stream Interrupted Midway",
        message: `${streamInfo.reason} Because of this, the component has syntax errors and cannot be parsed or run properly.`,
        recommendation: "Tap 'Heal Incomplete Code' to let our healing compiler automatically close open brackets, generate missing exports, and restore compiling state seamlessly!"
      });
    }

    // Check for direct state mutations (e.g., activeTab = "abc" instead of setActiveTab("abc"))
    anatomy.states.forEach((state) => {
      const directMutationRegex = new RegExp(`\\b${state.variable}\\s*=\\s*[^=]`);
      lines.forEach((line, index) => {
        const lineNum = index + 1;
        // Skip useState initialization line
        if (lineNum === state.line) return;
        
        if (directMutationRegex.test(line) && !line.includes("const ") && !line.includes("let ") && !line.includes("var ")) {
          checks.push({
            type: "warning",
            title: "Direct State Mutation Detected",
            message: `Line ${lineNum} directly assigns a value to '${state.variable}'. This bypasses React's rendering system and the UI won't update.`,
            line: lineNum,
            recommendation: `Replace with the registered state setter call: '${state.setter}(newValue)'.`
          });
        }
      });
    });

    // Check for potential infinite loops in useEffect
    anatomy.effects.forEach((effect) => {
      if (effect.isRunAlways) {
        checks.push({
          type: "warning",
          title: "Unbounded Trigger Effect Loop",
          message: `The effect on line ${effect.line} has no dependency array. It will run on EVERY single state modification, which frequently causes browser lockups.`,
          line: effect.line,
          recommendation: "Provide a dependency array. E.g., 'useEffect(() => { ... }, [])' to run only on initial load, or specify state variables inside."
        });
      }
    });

    // Check for empty handler functions (common placeholder pattern)
    anatomy.handlers.forEach((handler) => {
      // Find the handler block
      let isEmpty = false;
      const startLine = handler.line - 1;
      if (startLine < lines.length) {
        const lineVal = lines[startLine];
        if (lineVal.includes("{}") || lineVal.includes("return;")) {
          isEmpty = true;
        }
      }

      if (isEmpty) {
        checks.push({
          type: "info",
          title: "Placeholder Operation Detected",
          message: `The function '${handler.name}' on line ${handler.line} contains no executable logic or returns early.`,
          line: handler.line,
          recommendation: "Describe what you want this handler to do in your workspace prompt to develop its code logic."
        });
      }
    });

    // Default Success Checks
    if (checks.length === 0) {
      checks.push({
        type: "success",
        title: "Clean React Architecture",
        message: "Your generated component adheres to robust React rendering rules. State setters are configured properly and hooks have valid dependency constraints.",
        recommendation: "Excellent structure! Tap 'Save Doc' to register this stable build in your history registry."
      });
    }

    return checks;
  }, [code, anatomy]);

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden h-full flex-1">
      
      {/* Tab Navigation header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800 gap-2">
        <div className="flex items-center gap-2">
          <Dna className="w-4 h-4 text-emerald-400 animate-pulse" />
          <span className="text-xs font-semibold text-slate-200">Reactive Anatomy</span>
        </div>
        
        {/* Sub-tab Pill Selectors */}
        <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800 self-start sm:self-auto overflow-x-auto max-w-full">
          <button
            onClick={() => setActiveSubTab("states")}
            className={`px-2 py-1 rounded text-[10px] font-medium transition duration-150 whitespace-nowrap ${
              activeSubTab === "states"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            States ({anatomy.states.length})
          </button>
          <button
            onClick={() => setActiveSubTab("effects")}
            className={`px-2 py-1 rounded text-[10px] font-medium transition duration-150 whitespace-nowrap ${
              activeSubTab === "effects"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Loops/Hooks ({anatomy.effects.length})
          </button>
          <button
            onClick={() => setActiveSubTab("handlers")}
            className={`px-2 py-1 rounded text-[10px] font-medium transition duration-150 whitespace-nowrap ${
              activeSubTab === "handlers"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Actions ({anatomy.handlers.length})
          </button>
          <button
            onClick={() => setActiveSubTab("sanity")}
            className={`px-2 py-1 rounded text-[10px] font-medium transition duration-150 whitespace-nowrap flex items-center gap-1 ${
              activeSubTab === "sanity"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Sanity Check ({sanityChecks.filter(c => c.type !== "success").length})
          </button>
        </div>
      </div>

      {/* Detail Content Panels */}
      <div className="flex-1 overflow-auto p-4 space-y-3">
        
        {/* 1. STATE VARIABLES PANEL */}
        {activeSubTab === "states" && (
          <div className="space-y-3">
            {anatomy.states.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-xs italic">
                No active state variables found. Use inputs or timers to declare reactive state values.
              </div>
            ) : (
              anatomy.states.map((state, i) => {
                const isLineActive = highlightedLine === state.line;
                return (
                  <div
                    key={i}
                    onClick={() => onHighlightLine(state.line)}
                    className={`group border rounded-xl p-3 cursor-pointer transition duration-150 text-left relative overflow-hidden ${
                      isLineActive
                        ? "bg-emerald-500/5 border-emerald-500/40 shadow-inner"
                        : "bg-slate-950/40 border-slate-800/80 hover:bg-slate-950/80 hover:border-slate-800"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs font-semibold text-amber-400">
                          {state.variable}
                        </span>
                        <ChevronRight className="w-3 h-3 text-slate-600" />
                        <span className="font-mono text-[10px] text-slate-500 bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded">
                          {state.setter}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <VoiceReadoutButton 
                          title={`State variable ${state.variable}`} 
                          line={state.line} 
                          textToSpeak={state.role} 
                          label="Read Voice"
                        />
                        <span className="text-[10px] text-slate-500 font-mono bg-slate-900/60 border border-slate-800/50 px-2 py-0.5 rounded group-hover:text-emerald-400 group-hover:border-emerald-500/20 transition duration-150">
                          Line {state.line}
                        </span>
                      </div>
                    </div>

                    <p className="text-slate-300 text-xs leading-relaxed font-light mb-2.5">
                      {state.role}
                    </p>

                    <div className="flex items-center gap-2 border-t border-slate-900/80 pt-2 text-[10px]">
                      <span className="text-slate-500 uppercase tracking-wider font-bold">Default:</span>
                      <code className="bg-slate-900/80 text-amber-200 border border-slate-800 px-1.5 py-0.5 rounded font-mono">
                        {state.defaultValue}
                      </code>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 2. REACTIVE LOOPS / EFFECTS PANEL */}
        {activeSubTab === "effects" && (
          <div className="space-y-3">
            {anatomy.effects.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-xs italic">
                No side-effect cycles declared. Include a 'useEffect' block to trigger dynamic storage updates or API integrations.
              </div>
            ) : (
              anatomy.effects.map((effect, i) => {
                const isLineActive = highlightedLine === effect.line;
                return (
                  <div
                    key={i}
                    onClick={() => onHighlightLine(effect.line)}
                    className={`group border rounded-xl p-3 cursor-pointer transition duration-150 text-left relative overflow-hidden ${
                      isLineActive
                        ? "bg-emerald-500/5 border-emerald-500/40 shadow-inner"
                        : "bg-slate-950/40 border-slate-800/80 hover:bg-slate-950/80 hover:border-slate-800"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-teal-400">
                          useEffect()
                        </span>
                        <span className={`text-[9px] px-2 py-0.5 rounded border ${
                          effect.isRunAlways 
                            ? "bg-rose-500/10 text-rose-400 border-rose-500/20" 
                            : effect.dependencies.length === 0 
                            ? "bg-blue-500/10 text-blue-400 border-blue-500/20" 
                            : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                        }`}>
                          {effect.isRunAlways ? "Unbounded Loop" : effect.dependencies.length === 0 ? "Mount Action" : "Linked Watch"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <VoiceReadoutButton 
                          title="Side effect loop useEffect" 
                          line={effect.line} 
                          textToSpeak={effect.role} 
                          label="Read Voice"
                        />
                        <span className="text-[10px] text-slate-500 font-mono bg-slate-900/60 border border-slate-800/50 px-2 py-0.5 rounded group-hover:text-emerald-400 group-hover:border-emerald-500/20 transition duration-150">
                          Line {effect.line}
                        </span>
                      </div>
                    </div>

                    <p className="text-slate-300 text-xs leading-relaxed font-light mb-2.5">
                      {effect.role}
                    </p>

                    {!effect.isRunAlways && (
                      <div className="flex items-center gap-2 border-t border-slate-900/80 pt-2 text-[10px]">
                        <span className="text-slate-500 uppercase tracking-wider font-bold">Watches:</span>
                        {effect.dependencies.length === 0 ? (
                          <span className="text-slate-400 italic font-mono bg-slate-900 px-1.5 py-0.5 rounded">None (Run once on load)</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {effect.dependencies.map((dep, dIdx) => (
                              <code key={dIdx} className="bg-slate-900/80 text-teal-300 border border-slate-800 px-1.5 py-0.5 rounded font-mono">
                                {dep}
                              </code>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 3. BUSINESS HANDLERS / ACTION PANEL */}
        {activeSubTab === "handlers" && (
          <div className="space-y-3">
            {anatomy.handlers.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-xs italic">
                No user action handlers detected. Declare click functions, inputs, or form submissions to bind logic actions.
              </div>
            ) : (
              anatomy.handlers.map((handler, i) => {
                const isLineActive = highlightedLine === handler.line;
                return (
                  <div
                    key={i}
                    onClick={() => onHighlightLine(handler.line)}
                    className={`group border rounded-xl p-3 cursor-pointer transition duration-150 text-left relative overflow-hidden ${
                      isLineActive
                        ? "bg-emerald-500/5 border-emerald-500/40 shadow-inner"
                        : "bg-slate-950/40 border-slate-800/80 hover:bg-slate-950/80 hover:border-slate-800"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <PlayCircle className="w-3.5 h-3.5 text-sky-400" />
                        <span className="font-mono text-xs font-semibold text-sky-400">
                          {handler.name}()
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <VoiceReadoutButton 
                          title={`Executable function ${handler.name}`} 
                          line={handler.line} 
                          textToSpeak={handler.role} 
                          label="Read Voice"
                        />
                        <span className="text-[10px] text-slate-500 font-mono bg-slate-900/60 border border-slate-800/50 px-2 py-0.5 rounded group-hover:text-emerald-400 group-hover:border-emerald-500/20 transition duration-150">
                          Line {handler.line}
                        </span>
                      </div>
                    </div>

                    <p className="text-slate-300 text-xs leading-relaxed font-light mb-2.5">
                      {handler.role}
                    </p>

                    <div className="flex items-center gap-2 border-t border-slate-900/80 pt-2 text-[10px]">
                      <span className="text-slate-500 uppercase tracking-wider font-bold">Parameters:</span>
                      {handler.parameters.length === 0 ? (
                        <span className="text-slate-400 italic font-mono bg-slate-900 px-1.5 py-0.5 rounded">None</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {handler.parameters.map((param, pIdx) => (
                            <code key={pIdx} className="bg-slate-900/80 text-sky-300 border border-slate-800 px-1.5 py-0.5 rounded font-mono">
                              {param}
                            </code>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 4. SANITY / DEBUG CODE CHECK */}
        {activeSubTab === "sanity" && (
          <div className="space-y-3">
            <div className="p-3 bg-slate-950/40 border border-slate-800/80 rounded-xl mb-4 text-xs font-light leading-relaxed text-slate-400">
              <span className="font-semibold text-emerald-400">Code Doc Sanity Scanner:</span> Scans raw react component blocks to identify asynchronous pitfalls, variable assignment leaks, and component timing traps before they crash your browser app.
            </div>

            {sanityChecks.map((check, i) => (
              <div
                key={i}
                onClick={() => check.line && onHighlightLine(check.line)}
                className={`border rounded-xl p-3.5 transition duration-150 text-left flex gap-3.5 relative overflow-hidden ${
                  check.line ? "cursor-pointer" : ""
                } ${
                  check.type === "success"
                    ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400"
                    : check.type === "critical"
                    ? "bg-rose-500/10 border-rose-500/30 text-rose-400"
                    : check.type === "warning"
                    ? "bg-amber-500/5 border-amber-500/20 text-amber-400"
                    : "bg-blue-500/5 border-blue-500/20 text-blue-400"
                }`}
              >
                <div className="mt-0.5">
                  {check.type === "success" ? (
                    <CheckCircle2 className="w-4.5 h-4.5 text-emerald-400 shrink-0" />
                  ) : check.type === "critical" ? (
                    <HeartPulse className="w-4.5 h-4.5 text-rose-400 shrink-0 animate-pulse" />
                  ) : check.type === "warning" ? (
                    <ShieldAlert className="w-4.5 h-4.5 text-amber-400 shrink-0" />
                  ) : (
                    <Zap className="w-4.5 h-4.5 text-blue-400 shrink-0" />
                  )}
                </div>

                <div className="flex-1 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold font-sans">
                      {check.title}
                    </span>
                    <div className="flex items-center gap-2">
                      <VoiceReadoutButton 
                        title={`Sanity check: ${check.title}`} 
                        line={check.line} 
                        textToSpeak={`${check.message} Recommendation: ${check.recommendation}`} 
                        label="Read Alert"
                      />
                      {check.line && (
                        <span className="text-[9px] font-mono bg-slate-900 px-2 py-0.5 border border-slate-800/50 rounded text-slate-400">
                          Line {check.line}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] leading-relaxed text-slate-300">
                    {check.message}
                  </p>
                  <div className="text-[10px] mt-2 text-slate-400 leading-relaxed pt-1.5 border-t border-slate-900">
                    <span className="font-semibold uppercase text-slate-500 text-[9px] tracking-wider block mb-0.5">Recommendation:</span>
                    {check.recommendation}
                  </div>

                  {check.type === "critical" && (
                    <div className="mt-4 pt-4 border-t border-rose-500/20 flex flex-col gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleHealCode();
                        }}
                        disabled={isHealing}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-500/20 hover:bg-rose-500/30 active:bg-rose-500/40 text-rose-200 rounded-xl font-medium text-xs transition duration-150 disabled:opacity-50 disabled:cursor-not-allowed border border-rose-500/30 shadow-md shadow-rose-950/20"
                      >
                        {isHealing ? (
                          <>
                            <RefreshCcw className="w-4 h-4 animate-spin text-rose-300" />
                            <span>Stitching code brackets & resolving exports...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-4 h-4 text-rose-300 animate-pulse" />
                            <span>Heal Incomplete Code (Restores Compiling State)</span>
                          </>
                        )}
                      </button>
                      {healError && (
                        <p className="text-[10px] text-rose-400/90 leading-relaxed font-mono bg-slate-950/80 border border-rose-500/10 p-2.5 rounded-lg mt-1 select-text">
                          ❌ Healer failed: {healError}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
