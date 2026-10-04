import React, { useState } from "react";
import { apiFetch } from "../utils/apiFetch";
import { FileCode, Loader2, FolderGit2 } from "lucide-react";
import CodeVisualizer from "./CodeVisualizer";
import { logError } from "../utils/logger";

interface ProjectFilesPanelProps {
  files: { path: string }[];
  title: string;
}

// File browser for multi-file generated projects. Click a file to view its
// content (served from the user's own workspace); scoring stays in the
// Cold Read Auditor's Step 2 with the "Uploaded workspace" source.
export default function ProjectFilesPanel({ files, title }: ProjectFilesPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const loadFile = async (path: string) => {
    setSelected(path);
    setLoading(true);
    setCode("");
    try {
      const res = await apiFetch(`/api/uploaded-file?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setCode(data.content || "");
      } else {
        setCode("// Could not load file content.");
      }
    } catch (err) {
      logError("load workspace file failed", err);
      setCode("// Could not load file content.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-3">
        <FolderGit2 className="w-4 h-4 text-teal-400" />
        <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wider">
          {title}
        </h3>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-teal-500/20 text-teal-300 border border-teal-500/30">
          {files.length} files
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 flex-1 min-h-0">
        <div className="space-y-1 overflow-y-auto pr-1 max-h-96 md:max-h-none">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => void loadFile(f.path)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition duration-150 ${
                selected === f.path
                  ? "bg-teal-500/10 border-teal-500/40 text-teal-200"
                  : "bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700 hover:text-slate-100"
              }`}
            >
              <FileCode className="w-3.5 h-3.5 shrink-0 text-teal-400" />
              <span className="text-[11px] font-mono truncate">{f.path}</span>
            </button>
          ))}
        </div>
        <div className="md:col-span-2 min-h-0 flex flex-col">
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-xs text-slate-400 py-12">
              <Loader2 className="w-4 h-4 animate-spin text-teal-400" /> Loading file...
            </div>
          ) : selected ? (
            <CodeVisualizer code={code} isGenerating={false} appName={selected} />
          ) : (
            <div className="flex items-center justify-center text-xs text-slate-500 py-12 border border-dashed border-slate-800 rounded-xl">
              Select a file to view its code. Score the whole project from the auditor tab.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
