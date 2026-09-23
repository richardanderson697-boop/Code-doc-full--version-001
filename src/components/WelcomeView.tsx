import React, { useState } from "react";
import { apiFetch } from "../utils/apiFetch";
import { 
  Sparkles, 
  Terminal, 
  ShieldAlert, 
  Layers, 
  Music, 
  Activity, 
  FileSpreadsheet, 
  ArrowRight, 
  BookOpen, 
  Cpu, 
  FileCode, 
  ClipboardPaste, 
  Check,
  Upload,
  FolderArchive,
  Loader2,
  Trash2
} from "lucide-react";
import { VibeProject } from "../types";
import { logError } from "../utils/logger";

interface WelcomeViewProps {
  onGenerate: (prompt: string) => void;
  onAuditExternalCode: (code: string) => void;
  onUploadZipCodebase: (files: { path: string; lineCount: number }[]) => void;
  isLoading: boolean;
  savedCount: number;
  onOpenRegistry: () => void;
}

export default function WelcomeView({ 
  onGenerate, 
  onAuditExternalCode,
  onUploadZipCodebase,
  isLoading, 
  savedCount, 
  onOpenRegistry 
}: WelcomeViewProps) {
  const [prompt, setPrompt] = useState("");
  const [activeTab, setActiveTab] = useState<"generate" | "audit" | "zip">("generate");
  const [externalCode, setExternalCode] = useState("");
  const [pasteFeedback, setPasteFeedback] = useState<"success" | "denied" | null>(null);

  // ZIP Upload States
  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState("");
  const [dragActive, setDragActive] = useState(false);

  const templates = [
    {
      title: "Task Matrix",
      desc: "A priority Eisenhower matrix todo tracker with categories, checkoffs, and daily progress bars.",
      prompt: "An Eisenhower matrix-based task planner. Categorize tasks into 'Urgent/Important', 'Important/Not Urgent', 'Urgent/Not Important', 'Not Urgent/Not Important'. Provide checkable list rows, drag-free category selectors, and a responsive daily progress ring to track productivity goals.",
      icon: Layers,
      color: "text-emerald-400",
      bg: "border-emerald-500/10 hover:border-emerald-500/30 hover:shadow-emerald-500/5",
    },
    {
      title: "Focus Soundscape",
      desc: "An ambient study board combining multiple audio looping noise mixers with pomodoro focus timers.",
      prompt: "A beautiful virtual study room with a soundboard, ambient noise mixer (Rain, Cafe, White Noise, Campfire) using mock or real audio oscillators, an interactive task list, and a fully customizable Pomodoro study timer with visual circular countdown animations.",
      icon: Music,
      color: "text-amber-400",
      bg: "border-amber-500/10 hover:border-amber-500/30 hover:shadow-amber-500/5",
    },
    {
      title: "Habit Streak Forge",
      desc: "A visual habit tracker showing daily checklist grids, streak totals, and monthly activity matrices.",
      prompt: "A modern daily habit streak tracker. Users add habits, click daily grid blocks to toggle completion, and see automatically incremented streak scores, milestone achievement badges, and a custom bento-grid visualization of habit consistency over a 7-day row.",
      icon: Activity,
      color: "text-sky-400",
      bg: "border-sky-500/10 hover:border-sky-500/30 hover:shadow-sky-500/5",
    },
    {
      title: "Dynamic Ledger",
      desc: "An invoice creator with auto-calculating tax/discounts, line editors, and export previews.",
      prompt: "A gorgeous invoice creator applet. Features editable line rows with item names, quantity, price, discount percentage, and automatically computed subtotals, VAT tax calculations, overall grand totals, currency selectors, and a clean professional template preview suited for export.",
      icon: FileSpreadsheet,
      color: "text-purple-400",
      bg: "border-purple-500/10 hover:border-purple-500/30 hover:shadow-purple-500/5",
    },
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isLoading) return;
    onGenerate(prompt);
  };

  const handleAuditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!externalCode.trim()) return;
    onAuditExternalCode(externalCode);
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setExternalCode(text);
        setPasteFeedback("success");
        setTimeout(() => setPasteFeedback(null), 2000);
      } else {
        setPasteFeedback("denied");
        setTimeout(() => setPasteFeedback(null), 4000);
      }
    } catch (err) {
      logError("Clipboard access denied inside iframe:", err);
      setPasteFeedback("denied");
      setTimeout(() => setPasteFeedback(null), 5000);
    }
  };

  const handleSelectTemplate = (p: string) => {
    setPrompt(p);
    setActiveTab("generate");
  };

  const handleZipUpload = async (file: File) => {
    if (!file) return;
    if (!file.name.endsWith(".zip")) {
      setZipError("Only .zip files are supported.");
      return;
    }

    setZipLoading(true);
    setZipError("");

    try {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = async () => {
        const base64String = (reader.result as string).split(",")[1];
        try {
          const response = await apiFetch("/api/upload-zip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ zipBase64: base64String })
          });

          const contentType = response.headers.get("content-type") || "";
          if (!contentType.includes("application/json")) {
            const text = await response.text();
            throw new Error(`Server returned unexpected HTML/text response instead of JSON. The backend might still be initializing. Details: ${text.slice(0, 150)}...`);
          }

          if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || "Failed to extract ZIP on server.");
          }

          const parsed = await response.json();
          onUploadZipCodebase(parsed.files || []);
        } catch (e: any) {
          setZipError(e.message || "An error occurred during upload or extraction.");
        } finally {
          setZipLoading(false);
        }
      };
      reader.onerror = () => {
        setZipError("Failed to read file.");
        setZipLoading(false);
      };
    } catch (e: any) {
      setZipError(e.message || "An unexpected error occurred.");
      setZipLoading(false);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      void handleZipUpload(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 md:py-16 flex flex-col justify-center min-h-[85vh] select-text">
      
      {/* Visual Header */}
      <div className="text-center mb-8 space-y-3">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold select-none">
          <Terminal className="w-3.5 h-3.5" /> High-Performance Code Documentation
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-slate-100 font-sans">
          Code Doc <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-teal-300">Workspace</span>
        </h1>
        <p className="text-slate-400 text-xs md:text-sm max-w-xl mx-auto font-light leading-relaxed">
          Create functional web applications from scratch, or analyze your external React/TypeScript code files under a completely objective, zero-memory lens.
        </p>
      </div>

      {/* Tab Selector */}
      <div className="flex bg-slate-900/80 border border-slate-800 p-1 rounded-xl mb-6 max-w-lg mx-auto select-none">
        <button
          onClick={() => setActiveTab("generate")}
          className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition duration-150 cursor-pointer ${
            activeTab === "generate"
              ? "bg-slate-800 border border-slate-700/80 text-emerald-400 font-bold shadow-inner"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
          <span>New App Builder</span>
        </button>
        <button
          onClick={() => setActiveTab("audit")}
          className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition duration-150 cursor-pointer ${
            activeTab === "audit"
              ? "bg-slate-800 border border-slate-700/80 text-rose-400 font-bold shadow-inner"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Cpu className="w-3.5 h-3.5 text-rose-400" />
          <span>Audit Single File</span>
        </button>
        <button
          onClick={() => setActiveTab("zip")}
          className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition duration-150 cursor-pointer ${
            activeTab === "zip"
              ? "bg-slate-800 border border-slate-700/80 text-indigo-400 font-bold shadow-inner"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <FolderArchive className="w-3.5 h-3.5 text-indigo-400" />
          <span>Upload ZIP Codebase</span>
        </button>
      </div>

      {/* Main Mode Selection Content */}
      {activeTab === "generate" ? (
        /* Mode 1: App Generator */
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 md:p-6 shadow-xl mb-12">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="E.g., 'A pomodoro timer with rain ambiance toggles, custom study lists, and budget trackers...'"
                rows={4}
                required
                className="w-full bg-slate-950 border border-slate-800 text-slate-200 placeholder:text-slate-600 rounded-xl p-4 text-sm leading-relaxed focus:outline-hidden focus:border-slate-700 focus:ring-1 focus:ring-slate-700 transition duration-150 font-sans resize-y"
              />
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1 border-t border-slate-800/60">
              <div className="flex items-center gap-1.5 text-xs text-slate-500 select-none">
                <BookOpen className="w-4 h-4 text-slate-600" />
                <span>Auto-generates side-by-side blueprints</span>
              </div>
              
              <div className="flex items-center gap-2">
                {savedCount > 0 && (
                  <button
                    type="button"
                    onClick={onOpenRegistry}
                    className="px-4 py-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-xl text-xs font-medium transition duration-150"
                  >
                    History Ledger ({savedCount})
                  </button>
                )}
                <button
                  type="submit"
                  disabled={!prompt.trim() || isLoading}
                  className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 text-slate-950 font-semibold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/10 transition duration-150"
                >
                  {isLoading ? "Writing blueprinters..." : "Build Code Doc"}
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : activeTab === "audit" ? (
        /* Mode 2: Paste External Code for Auditing */
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 md:p-6 shadow-xl mb-12">
          <form onSubmit={handleAuditSubmit} className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2 select-none">
              <label className="text-[10px] uppercase font-bold tracking-wider text-slate-400 flex items-center gap-1.5">
                <FileCode className="w-4 h-4 text-rose-400" /> Source Code for Cold-Audit
              </label>
              
              <button
                type="button"
                onClick={handlePasteClipboard}
                className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-950 border border-slate-800 hover:bg-slate-850 text-slate-300 flex items-center gap-1.5 hover:text-slate-100 transition duration-150"
              >
                <ClipboardPaste className="w-3.5 h-3.5 text-rose-400" />
                <span>Paste Clipboard</span>
              </button>
            </div>

            {/* Paste feedback notice */}
            {pasteFeedback === "success" && (
              <div className="text-[10px] text-emerald-400 font-mono flex items-center gap-1.5 py-1.5 bg-emerald-950/20 border border-emerald-900/30 rounded-lg px-3 animate-fadeIn">
                <Check className="w-3.5 h-3.5 text-emerald-400 animate-bounce" /> Copied successfully from clipboard!
              </div>
            )}

            {pasteFeedback === "denied" && (
              <div className="text-xs text-amber-300 font-sans p-3 bg-amber-500/5 border border-amber-500/15 rounded-xl leading-relaxed select-text">
                ⚠️ <strong>Browser sandboxing restrictions.</strong>
                <div className="mt-1">
                  • <strong>On Mobile/Touch:</strong> Tap or press & hold inside the text area below and select <strong>Paste</strong> from your device's menu.
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  • <strong>On Desktop:</strong> Click inside the text area below and press <kbd className="bg-slate-950 px-1.5 py-0.5 rounded text-slate-200 border border-slate-850 font-mono text-[10px] shadow-sm font-semibold">Ctrl + V</kbd> (or <kbd className="bg-slate-950 px-1.5 py-0.5 rounded text-slate-200 border border-slate-850 font-mono text-[10px] shadow-sm font-semibold">Cmd + V</kbd> on macOS).
                </div>
              </div>
            )}

            <div className="relative">
              <textarea
                value={externalCode}
                onChange={(e) => setExternalCode(e.target.value)}
                placeholder="Tap or click here to paste your React, TypeScript, or JavaScript code file. No other context is sent to the auditor..."
                rows={6}
                required
                className="w-full bg-slate-950 border border-slate-800 text-slate-200 placeholder:text-slate-600 rounded-xl p-4 text-xs font-mono leading-relaxed focus:outline-hidden focus:border-slate-700 focus:ring-1 focus:ring-slate-700 transition duration-150 resize-y"
              />
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1 border-t border-slate-800/60">
              <div className="flex items-center gap-1.5 text-xs text-slate-500 select-none">
                <ShieldAlert className="w-4 h-4 text-rose-500/70" />
                <span>Performs zero-memory structural trace checks</span>
              </div>
              
              <button
                type="submit"
                disabled={!externalCode.trim()}
                className="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-semibold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-rose-950/10 transition duration-150"
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>Open in Cold Read Auditor</span>
              </button>
            </div>
          </form>
        </div>
      ) : (
        /* Mode 3: ZIP Codebase Upload for Project Intelligence Analysis */
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 md:p-6 shadow-xl mb-12 space-y-4">
          <div 
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-2xl p-8 text-center transition duration-150 relative ${
              dragActive 
                ? "border-indigo-500 bg-indigo-500/10 text-indigo-300" 
                : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700 hover:bg-slate-950/60"
            }`}
          >
            {zipLoading ? (
              <div className="flex flex-col items-center justify-center space-y-3 py-6">
                <Loader2 className="w-10 h-10 animate-spin text-indigo-400" />
                <p className="text-xs font-mono uppercase tracking-wider text-indigo-300">Unzipping and staging codebase codebase...</p>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center cursor-pointer py-6 space-y-4">
                <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 hover:text-indigo-400 transition-colors">
                  <Upload className="w-8 h-8" />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-slate-300">
                    Drag and drop your project <span className="text-indigo-400 font-mono">.zip</span> here
                  </p>
                  <p className="text-[10px] text-slate-500">
                    or click to select file from your device
                  </p>
                </div>
                <input 
                  type="file" 
                  accept=".zip" 
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      void handleZipUpload(e.target.files[0]);
                    }
                  }}
                  className="hidden" 
                />
              </label>
            )}

            {zipError && (
              <p className="text-[10px] text-rose-400 mt-2 font-mono bg-rose-500/5 border border-rose-500/10 rounded-lg p-2.5">
                {zipError}
              </p>
            )}
          </div>

          <div className="bg-indigo-950/15 border border-indigo-500/10 rounded-xl p-4 flex items-start gap-3">
            <FolderArchive className="w-5 h-5 text-indigo-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <h5 className="font-bold text-xs text-slate-300 font-sans">
                About Accumulated Project Auditing
              </h5>
              <p className="text-[11px] text-slate-400 leading-relaxed font-light">
                Once uploaded, the auditor unzips, maps your files into a centralized file ledger, extracts Express API routers/React imports, and runs Step 2 Project Intelligence to evaluate and score the completeness of your workspace project!
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Templates Section */}
      <div className="space-y-4">
        <h3 className="text-xs uppercase tracking-wider text-slate-500 font-bold flex items-center gap-1.5 select-none">
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" /> Pre-configured App blueprinters
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map((template, idx) => {
            const Icon = template.icon;
            return (
              <div
                key={idx}
                onClick={() => handleSelectTemplate(template.prompt)}
                className={`bg-slate-950/40 hover:bg-slate-950/80 border p-4 rounded-xl cursor-pointer transition duration-200 flex items-start gap-3 group relative ${template.bg}`}
              >
                <div className={`p-2.5 rounded-lg bg-slate-900 border border-slate-800/80 shrink-0 ${template.color}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="space-y-1 pr-4">
                  <h4 className="font-semibold text-xs text-slate-200 group-hover:text-emerald-400 transition duration-150">
                    {template.title}
                  </h4>
                  <p className="text-[11px] text-slate-400 leading-relaxed font-light">
                    {template.desc}
                  </p>
                </div>
                <ArrowRight className="absolute right-4 bottom-4 w-3.5 h-3.5 text-slate-700 group-hover:text-slate-400 transition duration-150" />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
