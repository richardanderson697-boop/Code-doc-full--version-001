import React, { useState, useEffect, useRef } from "react";
import { apiFetch } from "../utils/apiFetch";
import { 
  Search, 
  AlertTriangle, 
  FileWarning, 
  ListChecks, 
  Loader2, 
  ClipboardPaste, 
  Cpu, 
  ArrowRight, 
  Check, 
  RefreshCw, 
  Terminal, 
  CheckCircle2, 
  XCircle, 
  Eye, 
  FileCode,
  ShieldAlert,
  Dna,
  Copy,
  GitBranch,
  Github,
  Settings,
  Send,
  MessageSquare,
  AlertCircle,
  FileText,
  Download,
  Brain,
  Database,
  Network,
  Files,
  Activity,
  FolderOpen,
  Layers,
  MapPin,
  CalendarDays,
  ShieldCheck,
  CheckSquare,
  Upload,
  Trash2,
  FolderArchive,
  Plus,
  Wand2,
  Save
} from "lucide-react";
import { motion } from "motion/react";
import { logError } from "../utils/logger";
import type { PreFlightReport } from "../../shared/preflight-types";
import { AuditResult } from "./auditor/types";
import PreFlightFindingsPanel from "./auditor/PreFlightFindingsPanel";
import ColdReadResults from "./auditor/ColdReadResults";
import IntelligenceReport from "./auditor/IntelligenceReport";
import GithubIntegrationTab from "./auditor/GithubIntegrationTab";

interface CodeAuditorProps {
  workspaceCode: string;
  isGenerating?: boolean;
  highlightedLine: number | null;
  onHighlightLine: (lineNum: number) => void;
}

export default function CodeAuditor({ 
  workspaceCode, 
  isGenerating = false,
  highlightedLine, 
  onHighlightLine 
}: CodeAuditorProps) {
  const [code, setCode] = useState(workspaceCode || "");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [autoSync, setAutoSync] = useState(false);
  const [pasteFeedback, setPasteFeedback] = useState<"success" | "denied" | null>(null);

  // Two Modes: "cold-read" | "project-intelligence"
  const [auditMode, setAuditMode] = useState<"cold-read" | "project-intelligence">("cold-read");

  // Project Intelligence states
  const [intelStatus, setIntelStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [intelResult, setIntelResult] = useState<any | null>(null);
  const [intelError, setIntelError] = useState("");

  // ZIP codebase upload states
  const [zipFiles, setZipFiles] = useState<{ path: string; lineCount: number }[]>([]);
  const [zipUploaded, setZipUploaded] = useState(false);
  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState("");
  const [dragActive, setDragActive] = useState(false);

  // Deterministic findings kept from a failed AI audit, so an outage of the
  // AI service still shows the scan results instead of only an error.
  const [degradedPreflight, setDegradedPreflight] = useState<PreFlightReport | null>(null);

  // New ZIP file selection states for Step 1
  const [selectedZipPath, setSelectedZipPath] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSearch, setFileSearch] = useState("");

  // Multi-Prompt Workspace Accumulator & File Builder States
  const [showFileBuilder, setShowFileBuilder] = useState(false);
  const [builderFilePath, setBuilderFilePath] = useState("src/types.ts");
  const [builderMode, setBuilderMode] = useState<"ai" | "manual" | "active">("ai");
  const [builderPrompt, setBuilderPrompt] = useState("");
  const [builderContent, setBuilderContent] = useState("");
  const [builderLoading, setBuilderLoading] = useState(false);
  const [builderError, setBuilderError] = useState("");
  const [builderSuccess, setBuilderSuccess] = useState("");
  const [filePurposes, setFilePurposes] = useState<Record<string, string>>({});

  // 1. Save manual or active code to workspace
  const handleSaveToWorkspace = async (targetPath: string, contentToSave: string) => {
    if (!targetPath.trim() || !contentToSave.trim()) {
      setBuilderError("File path and file content are required.");
      return;
    }
    setBuilderLoading(true);
    setBuilderError("");
    setBuilderSuccess("");
    try {
      const res = await apiFetch("/api/save-workspace-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: targetPath, content: contentToSave })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save file to workspace.");
      }
      setZipFiles(data.files || []);
      setZipUploaded(true);
      setBuilderSuccess(`Successfully saved "${data.filePath}" (${data.lineCount} lines) to workspace!`);
      setTimeout(() => setBuilderSuccess(""), 4000);
    } catch (err: any) {
      setBuilderError(err.message || "Error saving workspace file.");
    } finally {
      setBuilderLoading(false);
    }
  };

  // 2. AI Generate a specific file for workspace
  const handleGenerateWorkspaceFile = async () => {
    if (!builderFilePath.trim() || !builderPrompt.trim()) {
      setBuilderError("Please provide both a file path and prompt instructions.");
      return;
    }
    setBuilderLoading(true);
    setBuilderError("");
    setBuilderSuccess("");
    try {
      const res = await apiFetch("/api/generate-workspace-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: builderFilePath, prompt: builderPrompt })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to generate file for workspace.");
      }
      setZipFiles(data.files || []);
      setZipUploaded(true);
      if (data.purpose) {
        setFilePurposes(prev => ({ ...prev, [data.filePath]: data.purpose }));
      }
      setBuilderSuccess(`✨ Successfully created and documented "${data.filePath}" (${data.lineCount} lines) in workspace ledger!`);
      setBuilderPrompt("");
      setTimeout(() => setBuilderSuccess(""), 5000);
    } catch (err: any) {
      setBuilderError(err.message || "Error generating workspace file.");
    } finally {
      setBuilderLoading(false);
    }
  };

  // 3. Delete file from workspace
  const handleDeleteWorkspaceFile = async (filePathToDelete: string) => {
    try {
      const res = await apiFetch("/api/delete-workspace-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: filePathToDelete })
      });
      const data = await res.json();
      if (res.ok) {
        setZipFiles(data.files || []);
        if (data.files.length === 0) {
          setZipUploaded(false);
        }
      }
    } catch (err) {
      logError("Failed to delete workspace file:", err);
    }
  };

  // Sub tab control
  // The GitHub tab is a template-generator mockup until the real GitHub App
  // integration (push webhook -> Code Doc audit -> report committed back)
  // ships. Keep it hidden so users don't mistake it for a broken feature.
  const GITHUB_TAB_ENABLED = false;
  const [activeSubTab, setActiveSubTab] = useState<"audit" | "github">("audit");


  // Load ZIP upload status on mount
  useEffect(() => {
    const checkUploadStatus = async () => {
      try {
        const res = await fetch("/api/upload-status");
        if (res.ok) {
          const data = await res.json();
          if (data.uploaded) {
            setZipUploaded(true);
            setZipFiles(data.files || []);
            setAuditMode("project-intelligence");
          }
        }
      } catch (err) {
        logError("Failed to retrieve initial zip status", err);
      }
    };
    void checkUploadStatus();
  }, []);

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
          setZipFiles(parsed.files || []);
          setZipUploaded(true);
          setAuditMode("project-intelligence");
          setIntelResult(null);
          setIntelStatus("idle");
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

  const handleClearZip = async () => {
    setZipLoading(true);
    setZipError("");
    try {
      const response = await apiFetch("/api/clear-upload", {
        method: "POST"
      });
      if (response.ok) {
        setZipFiles([]);
        setZipUploaded(false);
        setIntelResult(null);
        setIntelStatus("idle");
      } else {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to clear on server.");
      }
    } catch (e: any) {
      setZipError(e.message || "Failed to clear uploaded codebase.");
    } finally {
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

  const handleLoadAndAuditUploadedFile = async (filePath: string) => {
    setFileLoading(true);
    setSelectedZipPath(filePath);
    setAuditMode("cold-read");
    setAutoSync(false); // Disable autoSync to prevent active workspace code from overwriting this file
    setStatus("loading");
    setError("");
    setResult(null);
    setDegradedPreflight(null);

    try {
      const res = await apiFetch(`/api/uploaded-file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to load file "${filePath}" from server.`);
      }
      
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error(`The server returned an invalid non-JSON response format (likely HTML fallback). Please refresh and try again.`);
      }
      
      const data = await res.json();
      setCode(data.content);

      // Trigger Step 1 file evidence audit on the fetched content!
      const auditRes = await apiFetch("/api/cold-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: data.content })
      });

      const auditContentType = auditRes.headers.get("content-type") || "";
      if (!auditContentType.includes("application/json")) {
        const text = await auditRes.text().catch(() => "");
        throw new Error(`Server returned HTML/text instead of JSON. The backend server might be compiling or restarting. Details: ${text.slice(0, 100)}`);
      }

      if (!auditRes.ok) {
        const errData = await auditRes.json().catch(() => ({}));
        if (errData.preflight) setDegradedPreflight(errData.preflight);
        throw new Error(errData.error || `Evidence extraction failed (status ${auditRes.status})`);
      }

      const auditData = await auditRes.json();
      // Ensure the result displays the correct filename
      auditData.fileName = filePath;
      setResult(auditData);
      setStatus("done");
    } catch (err: any) {
      const isFetchError = err.message && err.message.toLowerCase().includes("failed to fetch");
      setError(
        isFetchError
          ? "Failed to fetch. This usually occurs when the backend server is temporarily compiling or restarting after a code change. Please wait a moment and try clicking the file or 'Run Cold-Read Audit' again."
          : err.message || "Failed to load and audit file."
      );
      setStatus("error");
    } finally {
      setFileLoading(false);
    }
  };

  const lastWorkspaceCodeRef = useRef<string | null>(null);
  const zipStatusFetchedRef = useRef<boolean>(false);

  // Update our local editor code and auto-audit ONLY when the parent's workspaceCode actually changes
  useEffect(() => {
    if (workspaceCode !== undefined) {
      if (workspaceCode !== lastWorkspaceCodeRef.current) {
        lastWorkspaceCodeRef.current = workspaceCode;
        setCode(workspaceCode);
      }

      if (workspaceCode.includes("Custom ZIP Codebase Loaded Successfully!") && !zipStatusFetchedRef.current) {
        zipStatusFetchedRef.current = true;
        const fetchZipStatus = async () => {
          try {
            const res = await fetch("/api/upload-status");
            if (res.ok) {
              const contentType = res.headers.get("content-type") || "";
              if (contentType.includes("application/json")) {
                const data = await res.json();
                if (data.uploaded) {
                  setZipUploaded(true);
                  setZipFiles(data.files || []);
                  setAuditMode("project-intelligence");
                }
              }
            }
          } catch (err) {
            logError("Failed to retrieve zip status:", err);
          }
        };
        void fetchZipStatus();
      } else if (!workspaceCode.includes("Custom ZIP Codebase Loaded Successfully!")) {
        zipStatusFetchedRef.current = false;
      }

      // Only run auto-audit if autoSync is true, code exists, and we are not currently generating
      if (autoSync && !isGenerating && workspaceCode.trim() && !workspaceCode.includes("Custom ZIP Codebase Loaded Successfully!")) {
        const delayDebounce = setTimeout(() => {
          const autoAudit = async () => {
            setStatus("loading");
            setError("");
            setResult(null);
            try {
              const response = await apiFetch("/api/cold-audit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: workspaceCode })
              });

              const contentType = response.headers.get("content-type") || "";
              if (!contentType.includes("application/json")) {
                const text = await response.text().catch(() => "");
                throw new Error(`Server returned non-JSON response (${response.status}). Backend may be compiling. Details: ${text.slice(0, 100)}`);
              }

              if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || `Server error (status ${response.status})`);
              }

              const parsed = await response.json();
              setResult(parsed);
              setStatus("done");
            } catch (e: any) {
              setError(e.message || "Auditor connection timed out or returned invalid response.");
              setStatus("error");
            }
          };
          void autoAudit();
        }, 1500); // 1.5s debounce to protect API quotas

        return () => clearTimeout(delayDebounce);
      }
    }
  }, [workspaceCode, autoSync, isGenerating]);


  const handlePullFromWorkspace = () => {
    setIsSyncing(true);
    setCode(workspaceCode);
    setTimeout(() => {
      setIsSyncing(false);
    }, 400);
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setCode(text);
        setAutoSync(false); // Disable autoSync to prevent active workspace code from overwriting pasted code
        setPasteFeedback("success");
        setTimeout(() => setPasteFeedback(null), 2000);
      } else {
        setPasteFeedback("denied");
        setTimeout(() => setPasteFeedback(null), 4000);
      }
    } catch (err) {
      logError("Clipboard access denied or unavailable inside iframe:", err);
      setPasteFeedback("denied");
      setTimeout(() => setPasteFeedback(null), 5000);
    }
  };

  const handleClear = () => {
    setCode("");
    setResult(null);
    setStatus("idle");
    setError("");
  };

  const runAudit = async () => {
    if (!code.trim()) return;
    setStatus("loading");
    setError("");
    setResult(null);
    setDegradedPreflight(null);

    try {
      const response = await apiFetch("/api/cold-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
      });

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Server returned non-JSON response (${response.status}). The server may be compiling or restarting. Details: ${text.slice(0, 100)}`
        );
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        // The deterministic scan runs before the AI pass, so a failure
        // response still carries its findings. Keep them.
        if (errData.preflight) setDegradedPreflight(errData.preflight);
        throw new Error(errData.error || `Server error (status ${response.status})`);
      }

      const parsed = await response.json();
      setResult(parsed);
      setStatus("done");
    } catch (e: any) {
      const isFetchError = e.message && e.message.toLowerCase().includes("failed to fetch");
      setError(
        isFetchError
          ? "Failed to fetch. This usually occurs when the backend server is temporarily compiling or restarting after a code change. Please wait a moment and try clicking the file or 'Run Cold-Read Audit' again."
          : e.message || "Auditor connection timed out or returned invalid response."
      );
      setStatus("error");
    }
  };

  const runProjectIntelligence = async () => {
    setIntelStatus("loading");
    setIntelError("");
    setIntelResult(null);

    try {
      const response = await apiFetch("/api/project-intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Server returned non-JSON response (${response.status}). The server may be compiling or restarting.`
        );
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server error (status ${response.status})`);
      }

      const parsed = await response.json();
      setIntelResult(parsed);
      setIntelStatus("done");
    } catch (e: any) {
      const isFetchError = e.message && e.message.toLowerCase().includes("failed to fetch");
      setIntelError(
        isFetchError
          ? "Failed to fetch. This usually occurs when the backend server is temporarily compiling or restarting after a code change. Please wait a moment and try clicking the scan button again."
          : e.message || "Auditor connection timed out or returned invalid response."
      );
      setIntelStatus("error");
    }
  };


  // Helper to parse and extract the first line number from strings like "12", "12-15", "L12", "L12-15"
  const handleLineClick = (linesStr: string) => {
    if (!linesStr) return;
    const match = linesStr.match(/\d+/);
    if (match) {
      const lineNum = parseInt(match[0], 10);
      onHighlightLine(lineNum);
    }
  };

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden h-full flex-1">
      {/* Panel Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-950/80 border-b border-slate-800 select-none">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400">
            <Cpu className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <h4 className="font-bold text-xs text-slate-200 uppercase tracking-wider font-sans">
              Cold Read Auditor
            </h4>
            <p className="text-[10px] text-slate-500 font-mono">
              ZERO MEMORY • PURE CODE OBSERVATION
            </p>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-2">
          {workspaceCode && (
            <button
              onClick={handlePullFromWorkspace}
              disabled={status === "loading"}
              className={`px-2 py-1 rounded text-[10px] font-medium border flex items-center gap-1.5 transition duration-150 ${
                isSyncing
                  ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                  : "bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-300"
              }`}
              title="Pull the active code from the generator"
            >
              <RefreshCw className={`w-3 h-3 ${isSyncing ? "animate-spin" : ""}`} />
              <span>{isSyncing ? "Pulled!" : "Load Active Code"}</span>
            </button>
          )}

          {code && (
            <button
              onClick={handleClear}
              className="px-2 py-1 rounded text-[10px] font-medium bg-slate-950 border border-slate-850 hover:bg-slate-900 text-slate-400 hover:text-slate-300 transition duration-150"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Sub-navigation tabs: Cold Analysis vs GitHub Actions Setup */}
      <div className="flex border-b border-slate-800 bg-slate-950/40 p-1.5 gap-1.5 select-none shrink-0">
        <button
          type="button"
          onClick={() => setActiveSubTab("audit")}
          className={`flex-1 py-1.5 px-3 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 transition duration-150 cursor-pointer ${
            activeSubTab === "audit"
              ? "bg-rose-500/10 border border-rose-500/25 text-rose-300 shadow-inner font-semibold"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
          }`}
        >
          <Search className="w-3.5 h-3.5" />
          <span>🔍 Cold Analysis</span>
        </button>

        {GITHUB_TAB_ENABLED && (
        <button
          type="button"
          onClick={() => setActiveSubTab("github")}
          className={`flex-1 py-1.5 px-3 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 transition duration-150 cursor-pointer ${
            activeSubTab === "github"
              ? "bg-indigo-500/10 border border-indigo-500/25 text-indigo-300 shadow-inner font-semibold"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
          }`}
        >
          <Github className="w-3.5 h-3.5" />
          <span>🐙 GitHub Actions CI/CD</span>
        </button>
        )}
      </div>

      {/* Main Layout Workspace - Scrollable */}
      {/* Both sub-tabs stay mounted and are toggled with CSS, matching the
          right-hand panel tabs in App.tsx. Unmounting the inactive one would
          discard the config the user typed into it. */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className={activeSubTab === "audit" ? "space-y-4" : "hidden"}>
            {/* Two Mode Auditing Selector */}
            <div className="grid grid-cols-2 bg-slate-950 p-1 rounded-xl border border-slate-800/80 mb-4 select-none shrink-0">
              <button
                type="button"
                onClick={() => setAuditMode("cold-read")}
                className={`py-2 px-3 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 transition duration-150 cursor-pointer ${
                  auditMode === "cold-read"
                    ? "bg-rose-500/10 border border-rose-500/20 text-rose-300 font-semibold shadow-inner"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <FileCode className="w-3.5 h-3.5 text-rose-400" />
                <span>Step 1 — File Evidence Extractor</span>
              </button>

              <button
                type="button"
                onClick={() => setAuditMode("project-intelligence")}
                className={`py-2 px-3 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 transition duration-150 cursor-pointer ${
                  auditMode === "project-intelligence"
                    ? "bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 font-semibold shadow-inner"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <Brain className="w-3.5 h-3.5 text-indigo-400" />
                <span>Step 2 — Project Completion Evaluator</span>
              </button>
            </div>

            {auditMode === "cold-read" ? (
              <div className="space-y-2.5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-wrap select-none">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-slate-400 flex items-center gap-1.5">
                    <FileCode className="w-3.5 h-3.5 text-rose-400" /> Source Code for Audit
                  </label>
                  {code && (
                    <span className={`text-[8px] font-mono font-bold uppercase px-1.5 py-0.5 rounded-md border tracking-wider select-none ${
                      selectedZipPath
                        ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20 animate-pulse"
                        : code.trim() === workspaceCode.trim()
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                        : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                    }`}>
                      {selectedZipPath ? `📁 ZIP: ${selectedZipPath}` : code.trim() === workspaceCode.trim() ? "📍 Active Workspace Code" : "📝 External Paste Code"}
                    </span>
                  )}
                </div>
                
                <div className="flex items-center gap-3">
                  {/* Auto sync switch */}
                  <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-slate-400 hover:text-slate-200 transition select-none">
                    <input
                      type="checkbox"
                      checked={autoSync}
                      onChange={(e) => {
                        setAutoSync(e.target.checked);
                        if (e.target.checked) setSelectedZipPath(null);
                      }}
                      className="w-3.5 h-3.5 rounded bg-slate-950 border-slate-800 text-rose-500 focus:ring-0 focus:ring-offset-0 accent-rose-500 cursor-pointer"
                    />
                    <span>Auto-sync with active workspace</span>
                  </label>
 
                  {/* Paste from clipboard */}
                  <button
                    type="button"
                    onClick={() => {
                      void handlePasteFromClipboard();
                      setSelectedZipPath(null);
                    }}
                    className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-900 border border-slate-700/80 hover:bg-slate-800 text-slate-300 flex items-center gap-1 hover:text-slate-100 transition duration-150 cursor-pointer"
                    title="Paste from your system clipboard"
                  >
                    <ClipboardPaste className="w-3 h-3 text-rose-400" />
                    <span>Paste Clipboard</span>
                  </button>
                </div>
              </div>

              {/* Paste feedback notice */}
              {pasteFeedback === "success" && (
                <div className="text-[10px] text-emerald-400 font-mono flex items-center gap-1.5 py-1 bg-emerald-950/20 border border-emerald-900/30 rounded-lg px-2 animate-fadeIn">
                  <Check className="w-3.5 h-3.5 text-emerald-400 animate-bounce" /> Successfully pasted from clipboard!
                </div>
              )}
 
              {pasteFeedback === "denied" && (
                <div className="text-[10px] text-amber-300 font-sans p-2.5 bg-amber-500/5 border border-amber-500/15 rounded-lg leading-relaxed select-text animate-fadeIn">
                  ⚠️ <strong>Browser Security Restricted Clipboard Access</strong> (common in secure app sandboxes). 
                  <div className="mt-1">
                    • <strong>On Mobile/Touch:</strong> Tap or press & hold inside the text area below and select <strong>Paste</strong>.
                  </div>
                  <div className="mt-1">
                    • <strong>On Desktop:</strong> Click inside the text area below and press <kbd className="bg-slate-950 px-1.5 py-0.5 rounded text-slate-200 border border-slate-800 font-mono text-[9px] shadow-sm font-semibold">Ctrl + V</kbd> (or <kbd className="bg-slate-950 px-1.5 py-0.5 rounded text-slate-200 border border-slate-800 font-mono text-[9px] shadow-sm font-semibold">Cmd + V</kbd> on macOS).
                  </div>
                </div>
              )}

              {/* ZIP File Explorer Panel */}
              {zipUploaded && zipFiles.length > 0 && (
                <div className="bg-slate-950/70 border border-slate-850 rounded-xl p-3.5 space-y-3 animate-fadeIn">
                  <div className="flex items-center justify-between select-none">
                    <div className="flex items-center gap-2">
                      <FolderArchive className="w-4 h-4 text-indigo-400" />
                      <span className="text-[10px] uppercase font-bold tracking-wider text-slate-300 font-sans">
                        Select File to Extract Evidence ({zipFiles.length})
                      </span>
                    </div>
                    {selectedZipPath && (
                      <span className="text-[9px] font-mono font-bold bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 px-2 py-0.5 rounded-lg truncate max-w-[200px]" title={selectedZipPath}>
                        Selected: {selectedZipPath.split("/").pop()}
                      </span>
                    )}
                  </div>

                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-500" />
                    <input
                      type="text"
                      placeholder="Filter uploaded files..."
                      value={fileSearch}
                      onChange={(e) => setFileSearch(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800/80 rounded-lg py-1.5 pl-8 pr-3 text-[10px] font-mono text-slate-200 placeholder-slate-600 focus:outline-hidden focus:border-indigo-500/50"
                    />
                  </div>

                  <div className="max-h-36 overflow-y-auto bg-slate-950 border border-slate-900 rounded-lg p-2 text-[10px] font-mono space-y-1 scrollbar-thin">
                    {zipFiles
                      .filter((f) => f.path.toLowerCase().includes(fileSearch.toLowerCase()))
                      .map((f, idx) => {
                        const isActive = selectedZipPath === f.path;
                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => handleLoadAndAuditUploadedFile(f.path)}
                            disabled={fileLoading}
                            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded transition duration-150 cursor-pointer text-left ${
                              isActive
                                ? "bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 font-bold"
                                : "hover:bg-slate-900 text-slate-400 hover:text-slate-200"
                            }`}
                          >
                            <div className="flex items-center gap-1.5 truncate">
                              <FileCode className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-indigo-400" : "text-slate-500"}`} />
                              <span className="truncate">{f.path}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[8px] text-slate-500 font-bold">{f.lineCount} lines</span>
                              <span className={`text-[8px] uppercase tracking-wider font-sans font-bold px-1.5 py-0.5 rounded ${
                                isActive ? "bg-indigo-500/30 text-indigo-300 animate-pulse" : "bg-slate-900 text-slate-500"
                              }`}>
                                {isActive ? "Auditing..." : "Audit File"}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              <div className="relative">
                <textarea
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    // Turn off auto-sync if user starts manual editing or pasting
                    if (autoSync) {
                      setAutoSync(false);
                    }
                  }}
                  placeholder="Tap/click here to paste or type any React, TypeScript, or JavaScript code you want to analyze..."
                  spellCheck={false}
                  className="w-full h-52 bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 text-[11px] font-mono text-slate-300 placeholder-slate-600 focus:outline-hidden focus:border-rose-500/50 resize-y leading-relaxed"
                />
              </div>
              
              <button
                type="button"
                onClick={runAudit}
                disabled={status === "loading" || !code.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-500/10 hover:bg-rose-500/20 active:bg-rose-500/30 text-rose-300 hover:text-rose-200 rounded-xl font-semibold text-xs transition duration-150 disabled:opacity-45 disabled:cursor-not-allowed border border-rose-500/20 shadow-md cursor-pointer"
              >
                {status === "loading" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-rose-400" />
                    <span className="font-mono">ANALYZING CODE STRUCTURES...</span>
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4 text-rose-400" />
                    <span>Run Cold-Read Audit</span>
                  </>
                )}
              </button>
            </div>
          ) : (
            /* ZIP Codebase Upload & Workspace Project Intelligence Card */
            <div className="space-y-4 animate-fadeIn">
              {/* Multi-Prompt Workspace Accumulator & File Generator */}
              <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl">
                      <Files className="w-5 h-5" />
                    </div>
                    <div>
                      <h5 className="font-bold text-slate-200 text-xs font-sans flex items-center gap-2">
                        <span>Multi-Prompt Workspace Accumulator</span>
                        <span className="bg-indigo-500/20 text-indigo-300 text-[9px] px-2 py-0.5 rounded-full border border-indigo-500/30 font-mono">
                          {zipFiles.length} {zipFiles.length === 1 ? "file" : "files"}
                        </span>
                      </h5>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        Build complex applications incrementally across multiple prompts. Generate files, paste raw code, or upload ZIP archives.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <button
                      type="button"
                      onClick={() => setShowFileBuilder(!showFileBuilder)}
                      className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition shadow-sm cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>{showFileBuilder ? "Close Builder" : "➕ Add / Generate File"}</span>
                    </button>

                    {workspaceCode && (
                      <button
                        type="button"
                        onClick={() => handleSaveToWorkspace("src/App.tsx", workspaceCode)}
                        disabled={builderLoading}
                        title="Save active code from main editor into workspace as src/App.tsx"
                        className="flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 rounded-xl text-xs font-semibold transition cursor-pointer"
                      >
                        <Save className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="hidden md:inline">Save Main Code</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline File Builder Drawer */}
                {showFileBuilder && (
                  <div className="bg-slate-950/90 border border-indigo-500/30 rounded-xl p-4 space-y-3.5 animate-fadeIn">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-indigo-300 uppercase tracking-wider font-mono flex items-center gap-1.5">
                        <Wand2 className="w-4 h-4 text-indigo-400" />
                        <span>Interactive File Creator & Generator</span>
                      </span>

                      <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-0.5">
                        <button
                          type="button"
                          onClick={() => setBuilderMode("ai")}
                          className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition ${builderMode === "ai" ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}
                        >
                          ⚡ AI Generate
                        </button>
                        <button
                          type="button"
                          onClick={() => setBuilderMode("manual")}
                          className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition ${builderMode === "manual" ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}
                        >
                          📝 Paste Code
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono block">
                        Target File Path in Workspace
                      </label>
                      <input
                        type="text"
                        value={builderFilePath}
                        onChange={(e) => setBuilderFilePath(e.target.value)}
                        placeholder="e.g. src/types.ts, server.ts, src/components/Sidebar.tsx"
                        className="w-full bg-slate-900 border border-slate-800 focus:border-indigo-500 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none transition"
                      />
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {["src/types.ts", "server.ts", "src/App.tsx", "package.json", "src/components/Header.tsx"].map(path => (
                          <button
                            key={path}
                            type="button"
                            onClick={() => setBuilderFilePath(path)}
                            className="text-[9px] font-mono bg-slate-900/80 hover:bg-slate-800 text-slate-400 hover:text-indigo-300 border border-slate-800 rounded-md px-2 py-0.5 transition"
                          >
                            + {path}
                          </button>
                        ))}
                      </div>
                    </div>

                    {builderMode === "ai" ? (
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono block">
                          AI File Prompt Instructions
                        </label>
                        <textarea
                          rows={3}
                          value={builderPrompt}
                          onChange={(e) => setBuilderPrompt(e.target.value)}
                          placeholder="e.g. Create typescript interfaces for User, Transaction, and API responses with helper functions..."
                          className="w-full bg-slate-900 border border-slate-800 focus:border-indigo-500 rounded-xl p-3 text-xs font-sans text-slate-200 placeholder-slate-600 focus:outline-none transition resize-none"
                        />
                        <button
                          type="button"
                          onClick={handleGenerateWorkspaceFile}
                          disabled={builderLoading || !builderFilePath.trim() || !builderPrompt.trim()}
                          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 active:from-indigo-700 text-white rounded-xl text-xs font-bold transition shadow-md disabled:opacity-50 cursor-pointer"
                        >
                          {builderLoading ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin text-indigo-200" />
                              <span>Generating & Documenting File...</span>
                            </>
                          ) : (
                            <>
                              <Wand2 className="w-4 h-4" />
                              <span>Generate & Save File to Workspace</span>
                            </>
                          )}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono block">
                          Raw Code Content
                        </label>
                        <textarea
                          rows={5}
                          value={builderContent}
                          onChange={(e) => setBuilderContent(e.target.value)}
                          placeholder="Paste full TypeScript / React / Express code here..."
                          className="w-full bg-slate-900 border border-slate-800 focus:border-indigo-500 rounded-xl p-3 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none transition resize-none"
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveToWorkspace(builderFilePath, builderContent)}
                          disabled={builderLoading || !builderFilePath.trim() || !builderContent.trim()}
                          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-md disabled:opacity-50 cursor-pointer"
                        >
                          {builderLoading ? (
                            <Loader2 className="w-4 h-4 animate-spin text-emerald-200" />
                          ) : (
                            <Save className="w-4 h-4" />
                          )}
                          <span>Save Raw Code to Workspace</span>
                        </button>
                      </div>
                    )}

                    {builderError && (
                      <p className="text-[10px] text-rose-400 font-mono bg-rose-500/10 border border-rose-500/20 rounded-lg p-2">
                        {builderError}
                      </p>
                    )}

                    {builderSuccess && (
                      <p className="text-[10px] text-emerald-300 font-mono bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 flex items-center gap-1.5 animate-fadeIn">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span>{builderSuccess}</span>
                      </p>
                    )}
                  </div>
                )}

                {/* ZIP Drag and Drop / Workspace Ledger Area */}
                <div 
                  onDragEnter={handleDrag}
                  onDragOver={handleDrag}
                  onDragLeave={handleDrag}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed rounded-2xl p-4 text-center transition duration-150 relative ${
                    dragActive 
                      ? "border-indigo-500 bg-indigo-500/10 text-indigo-300" 
                      : zipUploaded 
                      ? "border-slate-800/80 bg-slate-950/60 text-slate-300"
                      : "border-slate-800/80 bg-slate-950/30 text-slate-400 hover:border-slate-700"
                  }`}
                >
                  {zipLoading ? (
                    <div className="flex flex-col items-center justify-center space-y-3 py-4">
                      <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                      <p className="text-xs font-mono uppercase tracking-wider text-indigo-300">Unzipping and compiling project files...</p>
                    </div>
                  ) : zipUploaded && zipFiles.length > 0 ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between px-1">
                        <div className="text-left">
                          <h6 className="font-bold text-slate-200 text-xs font-sans flex items-center gap-2">
                            <FolderArchive className="w-4 h-4 text-emerald-400" />
                            <span>Accumulated Workspace Codebase</span>
                          </h6>
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            {zipFiles.length} files stored in workspace memory. Click any file to extract Step 1 evidence or generate additional files.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={handleClearZip}
                          className="flex items-center gap-1.5 px-2.5 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 border border-rose-500/20 rounded-lg text-[10px] font-bold uppercase transition duration-150 cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>Clear Workspace</span>
                        </button>
                      </div>

                      <div className="max-h-48 overflow-y-auto bg-slate-950/80 border border-slate-900 rounded-xl p-2 text-left text-[10px] font-mono space-y-1.5 scrollbar-thin">
                        <div className="sticky top-0 bg-slate-950/95 pb-1 mb-1 border-b border-slate-900 font-bold text-slate-400 flex justify-between uppercase tracking-widest text-[8px] select-none z-10 px-1">
                          <span>File Path & Documentation</span>
                          <span>Actions</span>
                        </div>
                        {zipFiles.map((file, idx) => (
                          <div
                            key={idx}
                            className="w-full flex items-center justify-between hover:bg-slate-900/60 rounded-lg px-2 py-1.5 transition-colors border border-transparent hover:border-slate-800 group"
                          >
                            <div className="truncate pr-2 flex-1">
                              <div className="flex items-center gap-1.5">
                                <FileCode className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                                <span className="font-semibold text-slate-200 truncate">{file.path}</span>
                                <span className="text-slate-500 text-[9px] shrink-0">({file.lineCount} lines)</span>
                              </div>
                              {filePurposes[file.path] && (
                                <p className="text-[9px] text-slate-400 font-sans italic truncate mt-0.5 pl-5">
                                  {filePurposes[file.path]}
                                </p>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => handleLoadAndAuditUploadedFile(file.path)}
                                className="px-2 py-0.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 hover:text-indigo-200 border border-indigo-500/20 rounded text-[9px] font-bold transition cursor-pointer"
                                title="Load and extract evidence in Step 1"
                              >
                                Audit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteWorkspaceFile(file.path)}
                                className="p-1 text-slate-500 hover:text-rose-400 transition cursor-pointer"
                                title="Delete file from workspace"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <label className="flex flex-col items-center justify-center cursor-pointer py-3 space-y-2">
                      <div className="p-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 hover:text-indigo-400 transition-colors">
                        <Upload className="w-5 h-5" />
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-xs font-semibold text-slate-300">
                          Or drag and drop a project <span className="text-indigo-400 font-mono">.zip</span> archive
                        </p>
                        <p className="text-[10px] text-slate-500">
                          Extracts all project files into workspace memory instantly
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
                    <p className="text-[10px] text-rose-400 mt-2 font-mono bg-rose-500/5 border border-rose-500/10 rounded-lg p-2">
                      {zipError}
                    </p>
                  )}
                </div>
              </div>

              {/* Workspace Project Intelligence Trigger Card */}
              <div className="bg-gradient-to-br from-indigo-950/25 to-slate-950/50 border border-indigo-500/15 rounded-2xl p-5 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl mt-0.5 shrink-0">
                    <Brain className="w-5 h-5 animate-pulse" />
                  </div>
                  <div>
                    <h5 className="font-bold text-slate-200 text-xs uppercase tracking-wider font-sans">
                      Full-Workspace Project Intelligence
                    </h5>
                    <p className="text-[10px] text-slate-400 leading-relaxed font-sans mt-1 max-w-xl">
                      {zipUploaded 
                        ? "Evaluates your uploaded ZIP codebase file-by-file. It lists files in a ledger, maps your custom API routes & components, and scores completeness."
                        : "Reads and parses all TypeScript, React, Express, and config files in your workspace recursively. It maps component-endpoint architecture and runs completeness checks."
                      }
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={runProjectIntelligence}
                  disabled={intelStatus === "loading"}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-500/10 hover:bg-indigo-500/20 active:bg-indigo-500/30 text-indigo-300 hover:text-indigo-200 rounded-xl font-semibold text-xs transition duration-150 disabled:opacity-45 disabled:cursor-not-allowed border border-indigo-500/20 shadow-md cursor-pointer"
                >
                  {intelStatus === "loading" ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                      <span className="font-mono text-[10px] uppercase">MAPPING AND GRADING CODEBASE...</span>
                    </>
                  ) : (
                    <>
                      <Brain className="w-4 h-4 text-indigo-400" />
                      <span>{zipUploaded ? "Scan Uploaded Codebase" : "Scan Full Project Workspace"}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ERROR PRESENTATION */}
          {auditMode === "cold-read" && status === "error" && error && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 border border-rose-500/25 bg-rose-500/5 rounded-xl p-4 select-text">
                <XCircle className="text-rose-500 flex-shrink-0 w-4.5 h-4.5 mt-0.5" />
                <div className="text-xs text-rose-300 font-mono leading-relaxed">
                  <strong className="text-rose-400 font-semibold uppercase block mb-1">Audit Connection Failure</strong>
                  {error}
                </div>
              </div>

              {/* The AI pass failed, but the deterministic scan runs locally and
                  already produced results. Show them rather than nothing. */}
              {degradedPreflight && (
                <>
                  <p className="text-[10px] text-slate-400 font-mono px-1">
                    The deterministic scan runs locally and completed successfully. Its findings are below.
                  </p>
                  <PreFlightFindingsPanel report={degradedPreflight} />
                </>
              )}
            </div>
          )}

          {auditMode === "project-intelligence" && intelStatus === "error" && intelError && (
            intelError.toLowerCase().includes("not enough files") ? (
              <div className="flex items-start gap-3 border border-amber-500/20 bg-amber-500/5 rounded-xl p-4 select-text">
                <FileWarning className="text-amber-400 flex-shrink-0 w-4.5 h-4.5 mt-0.5" />
                <div className="text-xs text-slate-300 font-sans leading-relaxed">
                  <strong className="text-amber-400 font-semibold uppercase block mb-1 select-none">No Custom Codebase Detected</strong>
                  <p className="text-slate-300">{intelError}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 border border-rose-500/25 bg-rose-500/5 rounded-xl p-4 select-text">
                <XCircle className="text-rose-500 flex-shrink-0 w-4.5 h-4.5 mt-0.5" />
                <div className="text-xs text-rose-300 font-mono leading-relaxed">
                  <strong className="text-rose-400 font-semibold uppercase block mb-1">Intelligence Mapping Failure</strong>
                  {intelError}
                </div>
              </div>
            )
          )}

            {/* Audit Results Presentation */}
            {auditMode === "cold-read" && status === "done" && result && (
              <ColdReadResults result={result} onLineClick={handleLineClick} />
            )}

            {/* 2. Workspace Project Intelligence Audit Results.
                Mounted whenever a report exists so the ledger search text and
                expanded rubric row survive switching back to Step 1; hidden
                rather than unmounted when another mode is active. */}
            {intelResult && (
              <div
                className={
                  auditMode === "project-intelligence" && intelStatus === "done" ? "" : "hidden"
                }
              >
                <IntelligenceReport
                  intelResult={intelResult}
                  onAuditFile={(p) => void handleLoadAndAuditUploadedFile(p)}
                />
              </div>
            )}
        </div>

        {GITHUB_TAB_ENABLED && (
        <div className={activeSubTab === "github" ? "" : "hidden"}>
          <GithubIntegrationTab result={result} />
        </div>
        )}
      </div>
    </div>
  );
}
