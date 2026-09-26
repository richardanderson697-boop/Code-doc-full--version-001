import React, { useState, useEffect, useMemo, useRef } from "react";
import { Sparkles, History, ArrowLeft, RefreshCw, Save, Copy, Check, Download, AlertCircle, FileText, Dna, Bug, Cpu, Wand2, Send, Plus, RotateCcw, Layers, Zap, LogOut } from "lucide-react";
import { VibeProject } from "./types";
import WelcomeView from "./components/WelcomeView";
import CodeVisualizer from "./components/CodeVisualizer";
import PurposeVisualizer from "./components/PurposeVisualizer";
import HistorySidebar from "./components/HistorySidebar";
import AnatomyInspector from "./components/AnatomyInspector";
import AIDebugger from "./components/AIDebugger";
import CodeAuditor from "./components/CodeAuditor";
import AuthModal from "./components/AuthModal";
import PricingModal from "./components/PricingModal";
import { parseReactAnatomy } from "./utils/anatomyParser";
import { logError } from "./utils/logger";
import { apiFetch, fetchMe, notifyBalance, AuthRequiredError, CreditsRequiredError } from "./utils/apiFetch";

export default function App() {
  const [projects, setProjects] = useState<VibeProject[]>([]);
  const [currentProject, setCurrentProject] = useState<VibeProject | null>(null);
  
  // Workspace states
  const [activeCode, setActiveCode] = useState("");
  const [activePurpose, setActivePurpose] = useState("");
  const [currentPrompt, setCurrentPrompt] = useState("");
  const [currentTitle, setCurrentTitle] = useState("");
  const [refinementInput, setRefinementInput] = useState("");
  const [refinementMode, setRefinementMode] = useState<"evolve" | "fresh">("evolve");
  
  // Interactive Analysis & Debugger States
  const [activeRightTab, setActiveRightTab] = useState<"blueprint" | "anatomy" | "debugger" | "auditor">("blueprint");
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);

  // Compute code anatomy reactively
  const anatomy = useMemo(() => {
    return parseReactAnatomy(activeCode);
  }, [activeCode]);

  // Reset highlighted line when code content changes
  useEffect(() => {
    if (highlightedLine !== null) {
      setHighlightedLine(null);
    }
  }, [activeCode]);
  
  // Controls
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [warningMessage, setWarningMessage] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [copied, setCopied] = useState(false);

  // Auth + credits
  const [user, setUser] = useState<{ id: string; email: string; credits: number } | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [pricingNotice, setPricingNotice] = useState("");

  useEffect(() => {
    void fetchMe().then(setUser);
    // After Stripe checkout, refresh the balance and clean the URL.
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      void fetchMe().then((u) => {
        setUser(u);
        if (u) setPricingNotice("");
      });
      params.delete("checkout");
      params.delete("pack");
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
    const onAuthRequired = () => setAuthOpen(true);
    const onCreditsRequired = (e: Event) => {
      const { balance, required } = (e as CustomEvent).detail ?? {};
      // The 402 carries the live balance, so the badge is correct even here.
      if (typeof balance === "number") {
        setUser((prev) => (prev ? { ...prev, credits: balance } : prev));
      }
      setPricingNotice(
        `You're low on credits (balance ${balance ?? 0}, this action needs ~${required ?? "?"}). Top up to continue — the free PreFlight scan always costs 0.`
      );
      setPricingOpen(true);
    };
    window.addEventListener("codedoc:auth-required", onAuthRequired);
    window.addEventListener("codedoc:credits-required", onCreditsRequired);
    // Live balance updates stamped on metered API responses (header or SSE
    // event) — the badge refreshes without a logout/login cycle.
    const onBalanceUpdated = (e: Event) => {
      const { balance } = (e as CustomEvent).detail ?? {};
      if (typeof balance === "number") {
        setUser((prev) => (prev ? { ...prev, credits: balance } : prev));
      }
    };
    window.addEventListener("codedoc:balance-updated", onBalanceUpdated);
    return () => {
      window.removeEventListener("codedoc:auth-required", onAuthRequired);
      window.removeEventListener("codedoc:credits-required", onCreditsRequired);
      window.removeEventListener("codedoc:balance-updated", onBalanceUpdated);
    };
  }, []);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      setUser(null);
    }
  };

  // Trigger post-generation objective code audit (for un-biased feature documentation & gaps identification)
  const handleAuditCode = async (codeToAudit?: string, originalPromptText?: string) => {
    const targetCode = codeToAudit || activeCode;
    const targetPrompt = originalPromptText || currentPrompt;
    if (!targetCode) return;

    setIsAuditing(true);
    try {
      const response = await apiFetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: targetCode,
          originalPrompt: targetPrompt
        })
      });

      if (!response.ok) {
        throw new Error("Audit service unavailable");
      }

      const data = await response.json();
      if (data.audit) {
        setActivePurpose(data.audit);
      }
    } catch (err: any) {
      setWarningMessage(`Objective audit notice: ${err.message || "Failed to finalize secondary audit analysis."}`);
    } finally {
      setIsAuditing(false);
    }
  };

  // Load projects from server DB on mount
  const fetchProjects = async () => {
    try {
      const response = await fetch("/api/projects");
      if (response.ok) {
        const data = await response.json();
        setProjects(data);
      }
    } catch (error) {
      logError("Failed to load saved projects:", error);
    }
  };

  useEffect(() => {
    void fetchProjects();
  }, []);

  // Split streamed content from ====PURPOSE==== and ====CODE==== markers with robust parsing
  const splitContent = (fullText: string) => {
    let purpose = "";
    let code = "";

    // Regexes to match various forms of the markers
    const purposeRegex = /====\s*PURPOSE\s*====|====\s*PURPOSE\s*|===\s*PURPOSE\s*===|##\s*PURPOSE|#\s*PURPOSE/i;
    const codeRegex = /====\s*CODE\s*====|====\s*CODE\s*|===\s*CODE\s*===|##\s*CODE|#\s*CODE/i;

    const purposeMatch = fullText.match(purposeRegex);
    const codeMatch = fullText.match(codeRegex);

    const purposeIndex = purposeMatch ? purposeMatch.index ?? -1 : -1;
    const codeIndex = codeMatch ? codeMatch.index ?? -1 : -1;

    const purposeLength = purposeMatch ? purposeMatch[0].length : 0;
    const codeLength = codeMatch ? codeMatch[0].length : 0;

    if (purposeIndex !== -1) {
      if (codeIndex !== -1) {
        if (purposeIndex < codeIndex) {
          purpose = fullText.substring(purposeIndex + purposeLength, codeIndex).trim();
          code = fullText.substring(codeIndex + codeLength).trim();
        } else {
          code = fullText.substring(codeIndex + codeLength, purposeIndex).trim();
          purpose = fullText.substring(purposeIndex + purposeLength).trim();
        }
      } else {
        purpose = fullText.substring(purposeIndex + purposeLength).trim();
      }
    } else if (codeIndex !== -1) {
      code = fullText.substring(codeIndex + codeLength).trim();
    } else {
      // Heuristic fallback: if no markers are found, check if an import statement exists
      const importIndex = fullText.indexOf("import ");
      if (importIndex !== -1) {
        purpose = fullText.substring(0, importIndex).trim();
        code = fullText.substring(importIndex).trim();
      } else {
        purpose = fullText.trim();
      }
    }

    return { purpose, code };
  };

  // Helper to generate a friendly title from prompt
  const generateTitleFromPrompt = (userPrompt: string): string => {
    const firstSentence = userPrompt.split(/[.!?]/)[0].trim();
    const words = firstSentence.split(/\s+/).slice(0, 4);
    const title = words
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
      .filter((w) => w.length > 0)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
    return title || "Custom App Vibe";
  };

  // Generate or Evolve Vibe Code Call
  const handleGenerate = async (promptText: string, isRefinement: boolean = false) => {
    setIsGenerating(true);
    setErrorMessage("");
    setWarningMessage("");
    setCurrentPrompt(promptText);

    let titleToSave = currentTitle;
    if (!isRefinement || !currentTitle) {
      titleToSave = generateTitleFromPrompt(promptText);
      setCurrentTitle(titleToSave);
    }
    if (!isRefinement) {
      setActiveCode("");
      setActivePurpose("");
    }

    try {
      const payload: any = { prompt: promptText };
      if (isRefinement && activeCode) {
        payload.existingCode = activeCode;
      }

      const response = await apiFetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.body) {
        throw new Error("No readable response body received from server");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let finished = false;
      let accumulatedText = "";
      let buffer = "";

      while (!finished) {
        const { value, done } = await reader.read();
        finished = done;
        if (value || done) {
          buffer += decoder.decode(value || new Uint8Array(), { stream: !finished });
          const lines = buffer.split("\n");
          
          if (finished) {
            buffer = "";
          } else {
            buffer = lines.pop() || "";
          }

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith("data: ")) {
              const dataStr = trimmedLine.slice(6).trim();
              if (dataStr === "[DONE]") {
                finished = true;
                break;
              }
              try {
                const parsed = JSON.parse(dataStr);
                if (typeof parsed.creditsBalance === "number") {
                  notifyBalance(parsed.creditsBalance);
                }
                if (parsed.text) {
                  accumulatedText += parsed.text;
                  const { purpose, code } = splitContent(accumulatedText);
                  
                  // Clean up potential markdown brackets inside code if any
                  let cleanedCode = code;
                  if (cleanedCode.startsWith("```typescript")) {
                    cleanedCode = cleanedCode.substring("```typescript".length);
                  } else if (cleanedCode.startsWith("```tsx")) {
                    cleanedCode = cleanedCode.substring("```tsx".length);
                  } else if (cleanedCode.startsWith("```javascript")) {
                    cleanedCode = cleanedCode.substring("```javascript".length);
                  } else if (cleanedCode.startsWith("```")) {
                    cleanedCode = cleanedCode.substring("```".length);
                  }
                  if (cleanedCode.endsWith("```")) {
                    cleanedCode = cleanedCode.substring(0, cleanedCode.length - 3);
                  }

                  setActiveCode(cleanedCode.trim());
                  setActivePurpose(purpose);
                }
                if (parsed.warning) {
                  setWarningMessage(parsed.warning);
                }
                if (parsed.error) {
                  setErrorMessage(parsed.error);
                  finished = true;
                }
              } catch (e) {
                // Ignore incomplete SSE lines
              }
            }
          }
        }
      }

      // Generation fully complete, auto-save to history database
      setIsGenerating(false);
      void autoSaveProject(titleToSave || currentTitle || "Custom Vibe App", promptText, accumulatedText);

      // Trigger dynamic objective post-generation audit to evaluate actual logic completed
      const { code } = splitContent(accumulatedText);
      let cleanedCode = code;
      if (cleanedCode.startsWith("```typescript")) cleanedCode = cleanedCode.substring("```typescript".length);
      else if (cleanedCode.startsWith("```tsx")) cleanedCode = cleanedCode.substring("```tsx".length);
      if (cleanedCode.endsWith("```")) cleanedCode = cleanedCode.substring(0, cleanedCode.length - 3);
      void handleAuditCode(cleanedCode.trim(), promptText);

    } catch (err: any) {
      setErrorMessage(err.message || "Connection failure during code vibe compilation.");
      setIsGenerating(false);

      // Run audit even on partial/failed code to diagnose incompleteness
      if (activeCode) {
        void handleAuditCode(activeCode, promptText);
      }
    }
  };

  // Automated persistence helper at end of generation stream
  const autoSaveProject = async (title: string, promptText: string, fullStreamText: string) => {
    const { purpose, code } = splitContent(fullStreamText);
    
    // Clean code formatting block
    let cleanedCode = code;
    if (cleanedCode.startsWith("```typescript")) cleanedCode = cleanedCode.substring("```typescript".length);
    else if (cleanedCode.startsWith("```tsx")) cleanedCode = cleanedCode.substring("```tsx".length);
    if (cleanedCode.endsWith("```")) cleanedCode = cleanedCode.substring(0, cleanedCode.length - 3);

    const projectPayload = {
      id: `vibe_${Date.now()}`,
      title,
      prompt: promptText,
      code: cleanedCode.trim(),
      purpose,
      createdAt: new Date().toISOString(),
    };

    setSaveStatus("saving");
    try {
      const response = await apiFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectPayload),
      });

      if (response.ok) {
        const data = await response.json();
        setCurrentProject(data.project);
        setSaveStatus("saved");
        void fetchProjects();
        setTimeout(() => setSaveStatus("idle"), 2000);
      } else {
        setSaveStatus("error");
      }
    } catch (e) {
      setSaveStatus("error");
    }
  };

  // Standard Manual Save Event
  const handleSave = async () => {
    if (!currentTitle || !currentPrompt) return;
    setSaveStatus("saving");

    const payload = {
      id: currentProject?.id || `vibe_${Date.now()}`,
      title: currentTitle,
      prompt: currentPrompt,
      code: activeCode,
      purpose: activePurpose,
      createdAt: currentProject?.createdAt || new Date().toISOString(),
    };

    try {
      const response = await apiFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json();
        setCurrentProject(data.project);
        setSaveStatus("saved");
        void fetchProjects();
        setTimeout(() => setSaveStatus("idle"), 3000);
      } else {
        setSaveStatus("error");
      }
    } catch (error) {
      setSaveStatus("error");
    }
  };

  // Delete project
  const handleDeleteProject = async (id: string) => {
    try {
      const response = await apiFetch(`/api/projects/${id}`, {
        method: "DELETE",
      });
      if (response.ok) {
        void fetchProjects();
        if (currentProject?.id === id) {
          handleNewVibe();
        }
      }
    } catch (e) {
      logError("Failed to delete project:", e);
    }
  };

  // Select project from registry
  const handleSelectProject = (project: VibeProject) => {
    setCurrentProject(project);
    setActiveCode(project.code);
    setActivePurpose(project.purpose);
    setCurrentPrompt(project.prompt);
    setCurrentTitle(project.title);
    setErrorMessage("");
  };

  // Reset and load Welcome View
  const handleNewVibe = () => {
    setCurrentProject(null);
    setActiveCode("");
    setActivePurpose("");
    setCurrentPrompt("");
    setCurrentTitle("");
    setErrorMessage("");
    setSaveStatus("idle");
  };

  // Clipboard copies
  const handleCopyCode = () => {
    if (!activeCode) return;
    navigator.clipboard.writeText(activeCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Download architectural breakdown notes
  const handleDownloadNotes = () => {
    if (!activePurpose) return;
    const mdContent = `# Architectural blueprint: ${currentTitle}\n\n## Original Prompt\n> ${currentPrompt}\n\n${activePurpose}`;
    const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "app"}_blueprint.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const hasActiveWorkspace = activeCode || activePurpose || isGenerating;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:bg-slate-800 focus:text-slate-100 focus:rounded-lg"
      >
        Skip to content
      </a>

      {/* Visual Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-5 py-3.5 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-3">
          {hasActiveWorkspace && (
            <button
              onClick={handleNewVibe}
              className="p-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition duration-150"
              title="Return to Dashboard"
              aria-label="Return to dashboard"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 select-none">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-bold text-xs text-slate-100 uppercase tracking-wider font-sans select-none">
                Code Doc
              </h2>
              {hasActiveWorkspace && (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={currentTitle}
                    onChange={(e) => setCurrentTitle(e.target.value)}
                    className="bg-transparent border-b border-transparent hover:border-slate-700 focus:border-emerald-500 focus:outline-hidden text-xs text-slate-400 font-medium py-0.5 max-w-[200px]"
                    placeholder="Project Name"
                    title="Rename Doc"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Global Controls */}
        <div className="flex items-center gap-2">
          {/* Credits + auth */}
          {user ? (
            <>
              <button
                onClick={() => { setPricingNotice(""); setPricingOpen(true); }}
                className="px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:border-amber-500/40 text-amber-300 text-xs font-medium flex items-center gap-1.5 transition duration-150"
                title="Buy more credits"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>{user.credits.toLocaleString()} credits</span>
              </button>
              <button
                onClick={handleLogout}
                className="p-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition duration-150"
                title={`Sign out (${user.email})`}
                aria-label="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          ) : (
            <button
              onClick={() => setAuthOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition duration-150"
            >
              Sign in
            </button>
          )}
          {hasActiveWorkspace && !isGenerating && (
            <>
              <button
                onClick={handleSave}
                disabled={saveStatus === "saving"}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition duration-150 ${
                  saveStatus === "saved"
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : "bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-300"
                }`}
              >
                <Save className="w-3.5 h-3.5" />
                <span>
                  {saveStatus === "saving"
                    ? "Saving..."
                    : saveStatus === "saved"
                    ? "Doc Saved!"
                    : "Save Doc"}
                </span>
              </button>
              
              <button
                onClick={handleCopyCode}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition duration-150 bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-300`}
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? "Copied!" : "Copy Code"}</span>
              </button>
            </>
          )}

          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 sm:px-3 sm:py-1.5 rounded-lg bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-slate-200 text-xs font-medium flex items-center gap-1.5 transition duration-150"
            title="Open Past Docs"
          >
            <History className="w-4 h-4" />
            <span className="hidden sm:inline">Doc Registry ({projects.length})</span>
          </button>
        </div>
      </header>

      {/* Main Container Workspace */}
      <main id="main-content" className="flex-1 flex flex-col min-h-0 bg-slate-950 relative overflow-hidden">
        {warningMessage && (
          <div className="mx-5 mt-4 p-3.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-xl flex items-center gap-3 text-xs select-text">
            <Sparkles className="w-4 h-4 text-amber-400 shrink-0 animate-pulse" />
            <div className="flex-1">
              <strong className="font-semibold">Workspace Fallback Active:</strong> {warningMessage}
            </div>
            <button
              onClick={() => setWarningMessage("")}
              className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 rounded-lg text-[11px] font-medium transition duration-150"
            >
              Dismiss
            </button>
          </div>
        )}

        {errorMessage && (
          <div className="mx-5 my-4 p-3.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl flex items-center gap-3 text-xs select-text">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <div className="flex-1">
              <strong className="font-semibold">Doc compile error:</strong> {errorMessage}
            </div>
            <button
              onClick={() => handleGenerate(currentPrompt)}
              className="px-2.5 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 rounded-lg text-[11px] font-medium transition duration-150 flex items-center gap-1.5"
            >
              <RefreshCw className="w-3 h-3" /> Retry Build
            </button>
          </div>
        )}

        {!hasActiveWorkspace ? (
          /* Welcome/Input screen */
          <div className="flex-1 overflow-y-auto">
            <WelcomeView
              onGenerate={handleGenerate}
              onAuditExternalCode={(pastedCode) => {
                setActiveCode(pastedCode);
                setActivePurpose("### EXTERNAL SOURCE CODE AUDIT\nThis is an external code file analyzed by the Cold Read Auditor. No active generator blueprint is attached to this workspace.");
                setCurrentPrompt("Auditing of external pasted React/TypeScript code.");
                setCurrentTitle("Pasted External Code");
                setActiveRightTab("auditor");
                setErrorMessage("");
                setWarningMessage("");
              }}
              onUploadZipCodebase={(files) => {
                setActiveCode(`// Custom ZIP Codebase Loaded Successfully!\n//\n// Extracted ${files.length} file(s) from your archive.\n// Click the "Scan Uploaded Codebase" button on the right to map and evaluate completeness.`);
                setActivePurpose(`### CUSTOM CODEBASE LOADED\nExtracted ${files.length} file(s) from your custom ZIP codebase. Standard workspace tracking has been adapted to parse your files under Step 2 (Project Completion Evaluator).`);
                setCurrentPrompt("Auditing of extracted custom React/Express project codebase.");
                setCurrentTitle("Custom ZIP Codebase");
                setActiveRightTab("auditor");
                setErrorMessage("");
                setWarningMessage("");
              }}
              isLoading={isGenerating}
              savedCount={projects.length}
              onOpenRegistry={() => setSidebarOpen(true)}
            />
          </div>
        ) : (
          /* Split Workspace Editor Screen */
          <div className="flex-1 flex flex-col p-5 gap-4 min-h-0">
            {/* Active Workspace Code Evolution & Refinement Dock */}
            <div className="bg-slate-900/90 border border-emerald-500/30 rounded-2xl p-3.5 shadow-xl backdrop-blur-md">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5 mb-2.5">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                    <Wand2 className="w-4 h-4 animate-pulse" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wider">
                        Evolve Code & Refine Features
                      </h3>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        {refinementMode === "evolve" ? "Incremental Mode (Preserves Code)" : "Fresh Vibe Mode"}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 font-light">
                      {refinementMode === "evolve"
                        ? "Keep coming back with refinements! AI builds directly ON TOP of your existing file."
                        : "Generates a brand new component from scratch."}
                    </p>
                  </div>
                </div>

                {/* Mode Selector Toggle */}
                <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 text-[11px] font-medium self-start md:self-auto">
                  <button
                    type="button"
                    onClick={() => setRefinementMode("evolve")}
                    className={`px-3 py-1 rounded-lg transition-all ${
                      refinementMode === "evolve"
                        ? "bg-emerald-500 text-slate-950 font-bold shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Incremental Evolution
                  </button>
                  <button
                    type="button"
                    onClick={() => setRefinementMode("fresh")}
                    className={`px-3 py-1 rounded-lg transition-all ${
                      refinementMode === "fresh"
                        ? "bg-slate-800 text-slate-100 font-bold shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Fresh Build
                  </button>
                </div>
              </div>

              {/* Input Box & Submit Action */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!refinementInput.trim() || isGenerating) return;
                  void handleGenerate(refinementInput, refinementMode === "evolve");
                  setRefinementInput("");
                }}
                className="flex items-center gap-2"
              >
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={refinementInput}
                    onChange={(e) => setRefinementInput(e.target.value)}
                    placeholder={
                      refinementMode === "evolve"
                        ? "Describe a feature refinement or addition (e.g., 'Add local storage caching', 'Add search filter bar', 'Add a user settings tab')..."
                        : "Describe a new app from scratch..."
                    }
                    className="w-full bg-slate-950 border border-slate-800 focus:border-emerald-500/70 focus:outline-none rounded-xl px-4 py-2.5 text-xs text-slate-100 placeholder-slate-500 transition-all pr-10"
                    disabled={isGenerating}
                  />
                  {refinementInput && (
                    <button
                      type="button"
                      onClick={() => setRefinementInput("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={!refinementInput.trim() || isGenerating}
                  className={`px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 transition duration-200 shrink-0 ${
                    !refinementInput.trim() || isGenerating
                      ? "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-800"
                      : "bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/20 active:scale-95"
                  }`}
                >
                  {isGenerating ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>{refinementMode === "evolve" ? "Evolving Code..." : "Building..."}</span>
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-3.5 h-3.5" />
                      <span>{refinementMode === "evolve" ? "Evolve Code" : "Build Vibe"}</span>
                    </>
                  )}
                </button>
              </form>

              {/* Quick Refinement Suggestion Chips */}
              {refinementMode === "evolve" && !isGenerating && (
                <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2 border-t border-slate-800/60">
                  <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mr-1">
                    Quick Refinements:
                  </span>
                  {[
                    "Add LocalStorage Persistence",
                    "Add Search & Filter Bar",
                    "Add User Settings View",
                    "Add Stats & Progress Summary",
                    "Add Dark Mode Theme Switcher",
                    "Add CSV Export Feature"
                  ].map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => {
                        setRefinementInput(`Add feature: ${chip} to the current codebase.`);
                      }}
                      className="px-2.5 py-1 rounded-lg bg-slate-950/80 hover:bg-emerald-500/10 border border-slate-800 hover:border-emerald-500/40 text-slate-300 hover:text-emerald-300 text-[11px] transition duration-150 flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3 text-emerald-400" />
                      <span>{chip}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Side-by-side Dual Panels */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5 min-h-0">
              
              {/* Left Pane - Code view */}
              <div className="h-full flex flex-col min-h-0">
                <CodeVisualizer 
                  code={activeCode} 
                  isGenerating={isGenerating} 
                  appName={currentTitle} 
                  highlightedLine={highlightedLine}
                  onLineClick={(lineNum) => {
                    setHighlightedLine(lineNum);
                    setActiveRightTab("debugger");
                  }}
                />
              </div>

              {/* Right Pane - Modular Multi-Tabs view */}
              <div className="h-full flex flex-col min-h-0 bg-slate-950">
                {/* Secondary Tab selector for Right Pane */}
                <div className="flex bg-slate-900/60 p-1.5 rounded-xl border border-slate-800 mb-3 select-none gap-1.5">
                  <button
                    onClick={() => setActiveRightTab("blueprint")}
                    className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition duration-150 ${
                      activeRightTab === "blueprint"
                        ? "bg-slate-850 border border-slate-700/80 text-emerald-400 font-semibold shadow-inner"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
                    }`}
                  >
                    <FileText className="w-4 h-4" />
                    <span>Blueprint</span>
                  </button>

                  <button
                    onClick={() => setActiveRightTab("anatomy")}
                    className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition duration-150 ${
                      activeRightTab === "anatomy"
                        ? "bg-slate-850 border border-slate-700/80 text-emerald-400 font-semibold shadow-inner"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
                    }`}
                  >
                    <Dna className="w-4 h-4" />
                    <span>Reactive Anatomy</span>
                  </button>

                  <button
                    onClick={() => setActiveRightTab("debugger")}
                    className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition duration-150 ${
                      activeRightTab === "debugger"
                        ? "bg-slate-850 border border-slate-700/80 text-emerald-400 font-semibold shadow-inner"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
                    }`}
                  >
                    <Bug className="w-4 h-4" />
                    <span>AI Vibe Debugger</span>
                  </button>

                  <button
                    onClick={() => setActiveRightTab("auditor")}
                    className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition duration-150 ${
                      activeRightTab === "auditor"
                        ? "bg-slate-850 border border-slate-700/80 text-emerald-400 font-semibold shadow-inner"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
                    }`}
                  >
                    <Cpu className="w-4 h-4" />
                    <span>Cold Auditor</span>
                  </button>
                </div>

                {/* Sub-Panel Contents */}
                <div className="flex-1 min-h-0 flex flex-col relative">
                  <div className={activeRightTab === "blueprint" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
                    <PurposeVisualizer
                      purpose={activePurpose}
                      isGenerating={isGenerating}
                      onDownloadNotes={handleDownloadNotes}
                      onTriggerAudit={() => handleAuditCode()}
                      isAuditing={isAuditing}
                    />
                  </div>

                  <div className={activeRightTab === "anatomy" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
                    <AnatomyInspector
                      anatomy={anatomy}
                      code={activeCode}
                      highlightedLine={highlightedLine}
                      onHighlightLine={(lineNum) => setHighlightedLine(lineNum)}
                      errorMessage={errorMessage}
                      originalPrompt={currentPrompt}
                      onHealCode={(healedCode) => {
                        setActiveCode(healedCode);
                        setErrorMessage("");
                      }}
                    />
                  </div>

                  <div className={activeRightTab === "debugger" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
                    <AIDebugger
                      code={activeCode}
                      onHighlightLine={(lineNum) => setHighlightedLine(lineNum)}
                      selectedLine={highlightedLine}
                    />
                  </div>

                  <div className={activeRightTab === "auditor" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
                    <CodeAuditor
                      workspaceCode={activeCode}
                      isGenerating={isGenerating}
                      highlightedLine={highlightedLine}
                      onHighlightLine={(lineNum) => setHighlightedLine(lineNum)}
                    />
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}
      </main>

      {/* Slide-over registry sidebar */}
      <HistorySidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        projects={projects}
        currentProjectId={currentProject?.id || null}
        onSelectProject={handleSelectProject}
        onDeleteProject={handleDeleteProject}
      />

      {/* Auth + billing modals */}
      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onAuthed={(u) => { setUser(u); setAuthOpen(false); }}
      />
      <PricingModal
        open={pricingOpen}
        notice={pricingNotice}
        onClose={() => { setPricingOpen(false); void fetchMe().then(setUser); }}
      />
    </div>
  );
}
