import React, { useState, useRef } from "react";
import { apiFetch } from "../utils/apiFetch";
import {
  ArrowRight,
  Plus,
  Trash2,
  Loader2,
  Square,
  Check,
  X,
  AlertTriangle,
  FolderGit2,
  FileCode,
  Sparkles,
} from "lucide-react";
import { logError } from "../utils/logger";

export interface ManifestFile {
  path: string;
  purpose: string;
}

export interface MultiFileInfo {
  title: string;
  prompt: string;
  files: { path: string }[];
}

interface MultiFileBuilderProps {
  onComplete: (info: MultiFileInfo) => void;
}

type Phase = "prompt" | "stale-confirm" | "planning" | "approval" | "generating" | "done";
type FileStatus = "pending" | "working" | "done" | "failed";

function friendlyTitle(promptText: string): string {
  const firstSentence = promptText.split(/[.!?]/)[0].trim();
  const words = firstSentence.split(/\s+/).slice(0, 4);
  const title = words
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  return title || "Custom App Vibe";
}

export default function MultiFileBuilder({ onComplete }: MultiFileBuilderProps) {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("prompt");
  const [stale, setStale] = useState<{ count: number; sample: string[] } | null>(null);
  const [manifest, setManifest] = useState<ManifestFile[] | null>(null);
  const [error, setError] = useState("");
  const [genItems, setGenItems] = useState<{ path: string; purpose: string; status: FileStatus }[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [newPath, setNewPath] = useState("");
  const [newPurpose, setNewPurpose] = useState("");
  const stopRef = useRef(false);

  const readBalance = (res: Response) => {
    const b = res.headers.get("X-Credits-Balance");
    if (b != null && !Number.isNaN(Number(b))) setBalance(Number(b));
  };

  // Step 1: stale-workspace check, then plan the manifest.
  const handlePlan = async () => {
    if (!prompt.trim()) return;
    setError("");
    setPhase("stale-confirm");
    try {
      const res = await fetch("/api/upload-status");
      if (res.ok) {
        const data = await res.json();
        if (data.uploaded && data.files && data.files.length > 0) {
          setStale({
            count: data.files.length,
            sample: data.files.slice(0, 2).map((f: any) => f.path),
          });
          return; // wait for the user's call on the confirm card
        }
      }
    } catch (err) {
      logError("upload-status check failed", err);
    }
    void planManifest();
  };

  const planManifest = async () => {
    setStale(null);
    setPhase("planning");
    setError("");
    try {
      const res = await apiFetch("/api/generate-manifest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      readBalance(res);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Manifest planning failed.");
      }
      const data = await res.json();
      setManifest(data.files || []);
      setPhase("approval");
    } catch (e: any) {
      setError(e.message || "Manifest planning failed.");
      setPhase("prompt");
    }
  };

  const clearAndPlan = async () => {
    try {
      await apiFetch("/api/clear-upload", { method: "POST" });
    } catch (err) {
      logError("clear-upload failed", err);
    }
    void planManifest();
  };

  const removeFile = (path: string) => {
    setManifest((m) => (m ? m.filter((f) => f.path !== path) : m));
  };

  const addFile = () => {
    const clean = newPath.trim().replace(/^\/+/, "");
    if (!clean || !clean.startsWith("src/") || clean.includes("..")) return;
    if (manifest && manifest.some((f) => f.path === clean)) return;
    setManifest((m) => (m ? [...m, { path: clean, purpose: newPurpose.trim() || "Custom file" }] : m));
    setNewPath("");
    setNewPurpose("");
  };

  // Step 2: sequential per-file generation. The loop is client-side so STOP
  // is immediate; the server caps make a runaway client harmless anyway.
  const handleGenerate = async () => {
    if (!manifest || manifest.length === 0) return;
    stopRef.current = false;
    setError("");
    setPhase("generating");
    setGenItems(manifest.map((f) => ({ ...f, status: "pending" as FileStatus })));

    for (let i = 0; i < manifest.length; i++) {
      if (stopRef.current) break;
      const file = manifest[i];
      setGenItems((items) => items.map((it, idx) => (idx === i ? { ...it, status: "working" } : it)));
      try {
        const res = await apiFetch("/api/generate-workspace-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filePath: file.path,
            prompt: `${prompt}\n\nFile to generate: ${file.path}\nPurpose: ${file.purpose}\nThis file is part of a ${manifest.length}-file project. Entry point: src/App.tsx.`,
          }),
        });
        readBalance(res);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Failed to generate ${file.path}`);
        }
        setGenItems((items) => items.map((it, idx) => (idx === i ? { ...it, status: "done" } : it)));
      } catch (e: any) {
        logError(`generate ${file.path} failed`, e);
        setGenItems((items) => items.map((it, idx) => (idx === i ? { ...it, status: "failed" } : it)));
      }
    }

    setPhase("done");
    if (stopRef.current) {
      setError("Stopped. Files generated so far are kept in your workspace.");
    }
  };

  const retryFile = async (index: number) => {
    if (!manifest) return;
    const file = manifest[index];
    setGenItems((items) => items.map((it, idx) => (idx === index ? { ...it, status: "working" } : it)));
    try {
      const res = await apiFetch("/api/generate-workspace-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: file.path,
          prompt: `${prompt}\n\nFile to generate: ${file.path}\nPurpose: ${file.purpose}\nThis file is part of a ${manifest.length}-file project. Entry point: src/App.tsx.`,
        }),
      });
      readBalance(res);
      if (!res.ok) throw new Error("retry failed");
      setGenItems((items) => items.map((it, idx) => (idx === index ? { ...it, status: "done" } : it)));
    } catch (e: any) {
      logError(`retry ${file.path} failed`, e);
      setGenItems((items) => items.map((it, idx) => (idx === index ? { ...it, status: "failed" } : it)));
    }
  };

  const doneCount = genItems.filter((i) => i.status === "done").length;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 md:p-6 shadow-xl mb-12">
      {/* Phase: prompt */}
      {phase === "prompt" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <FolderGit2 className="w-4 h-4 text-teal-400" />
            <span>Multi-file project: plan a file manifest first, approve it, then generate each file.</span>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="E.g., 'A kanban board with drag-and-drop columns, card labels, due dates, and a stats dashboard...'"
            rows={4}
            className="w-full bg-slate-950 border border-slate-800 text-slate-200 placeholder:text-slate-600 rounded-xl p-4 text-sm leading-relaxed focus:outline-hidden focus:border-slate-700 focus:ring-1 focus:ring-slate-700 transition duration-150 font-sans resize-y"
          />
          {error && (
            <p className="text-[11px] text-rose-400 font-mono bg-rose-500/5 border border-rose-500/10 rounded-lg p-2">{error}</p>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handlePlan}
              disabled={!prompt.trim()}
              className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 text-slate-950 font-semibold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/10 transition duration-150"
            >
              Plan Project <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Phase: stale workspace confirm */}
      {phase === "stale-confirm" && stale && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-500/40 bg-amber-500/10">
          <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-bold text-amber-200 uppercase tracking-wider">Workspace holds an earlier upload</p>
            <p className="text-[11px] text-amber-100/80 mt-1">
              {stale.count} file{stale.count === 1 ? "" : "s"} from an earlier upload ({stale.sample.join(", ")}) are still in your workspace. Starting a new project here would mix them in.
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <button type="button" onClick={clearAndPlan} className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-amber-500/20 border border-amber-500/40 text-amber-200 hover:bg-amber-500/30 transition">
                Clear workspace &amp; continue
              </button>
              <button type="button" onClick={() => { setStale(null); setPhase("prompt"); }} className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-slate-900 border border-slate-700 text-slate-300 hover:bg-slate-800 transition">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {phase === "stale-confirm" && !stale && (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-4">
          <Loader2 className="w-4 h-4 animate-spin text-teal-400" /> Checking workspace...
        </div>
      )}

      {/* Phase: planning */}
      {phase === "planning" && (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-teal-400" /> Planning your project structure...
        </div>
      )}

      {/* Phase: manifest approval */}
      {phase === "approval" && manifest && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-teal-400" /> Project plan — approve the files
            </h4>
            <span className="text-[10px] text-slate-500 font-mono">
              ~{manifest.length * 15} credits min
            </span>
          </div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {manifest.map((f) => (
              <div key={f.path} className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                <FileCode className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-mono text-slate-200 truncate">{f.path}</p>
                  <p className="text-[10px] text-slate-500 truncate">{f.purpose}</p>
                </div>
                <button type="button" onClick={() => removeFile(f.path)} title="Remove file" className="text-slate-500 hover:text-rose-400 transition shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="src/components/New.tsx" className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-[11px] font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-slate-700" />
            <input value={newPurpose} onChange={(e) => setNewPurpose(e.target.value)} placeholder="Purpose" className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-slate-700" />
            <button type="button" onClick={addFile} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-slate-200 transition" title="Add file">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex justify-between items-center pt-1">
            <button type="button" onClick={() => { setManifest(null); setPhase("prompt"); }} className="text-[11px] text-slate-500 hover:text-slate-300 transition">
              ← Back to prompt
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={manifest.length === 0}
              className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 text-slate-950 font-semibold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/10 transition duration-150"
            >
              Generate {manifest.length} file{manifest.length === 1 ? "" : "s"} <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Phase: generating / done */}
      {(phase === "generating" || phase === "done") && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
              {phase === "generating" ? "Generating project..." : "Project generated"}
            </h4>
            <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
              <span>{doneCount}/{genItems.length} files</span>
              {balance !== null && <span className="text-amber-300">{balance} credits</span>}
            </div>
          </div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {genItems.map((it, idx) => (
              <div key={it.path} className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                {it.status === "working" && <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-400 shrink-0" />}
                {it.status === "done" && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                {it.status === "failed" && <X className="w-3.5 h-3.5 text-rose-400 shrink-0" />}
                {it.status === "pending" && <FileCode className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
                <span className="flex-1 text-[11px] font-mono text-slate-200 truncate">{it.path}</span>
                {it.status === "failed" && phase === "done" && (
                  <button type="button" onClick={() => retryFile(idx)} className="text-[10px] font-bold uppercase text-teal-300 hover:text-teal-200 transition shrink-0">
                    Retry
                  </button>
                )}
              </div>
            ))}
          </div>
          {error && (
            <p className="text-[11px] text-amber-300 font-mono bg-amber-500/5 border border-amber-500/10 rounded-lg p-2">{error}</p>
          )}
          <div className="flex justify-between items-center pt-1">
            {phase === "generating" ? (
              <button
                type="button"
                onClick={() => { stopRef.current = true; }}
                className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 rounded-xl text-xs font-bold flex items-center gap-2 transition"
              >
                <Square className="w-3.5 h-3.5" /> STOP
              </button>
            ) : (
              <span className="text-[11px] text-slate-500">
                {genItems.some((i) => i.status === "failed") ? "Some files failed — retry them above or continue." : "All files generated into your workspace."}
              </span>
            )}
            {phase === "done" && (
              <button
                type="button"
                onClick={() => onComplete({ title: friendlyTitle(prompt), prompt, files: genItems.filter((i) => i.status === "done").map((i) => ({ path: i.path })) })}
                disabled={doneCount === 0}
                className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 text-slate-950 font-semibold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/10 transition duration-150"
              >
                Score this project <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
