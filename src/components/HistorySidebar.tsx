import React, { useState } from "react";
import { Search, Trash2, Calendar, FileText, ChevronRight, X, Sparkles } from "lucide-react";
import { VibeProject } from "../types";

interface HistorySidebarProps {
  isOpen: boolean;
  onClose: () => void;
  projects: VibeProject[];
  currentProjectId: string | null;
  onSelectProject: (project: VibeProject) => void;
  onDeleteProject: (id: string) => void;
}

export default function HistorySidebar({
  isOpen,
  onClose,
  projects,
  currentProjectId,
  onSelectProject,
  onDeleteProject,
}: HistorySidebarProps) {
  const [searchTerm, setSearchTerm] = useState("");

  const filteredProjects = projects.filter((project) =>
    project.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    project.prompt.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch (e) {
      return "Recently";
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Background Overlay */}
      <div 
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-xs z-40 transition-opacity duration-200"
      />

      {/* Sidebar Container */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-slate-900 border-l border-slate-800 shadow-2xl z-50 flex flex-col transition-transform duration-300">
        
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <h3 className="font-semibold text-slate-100 text-sm">Doc Registry</h3>
            <span className="bg-slate-800 text-[10px] text-slate-400 px-2 py-0.5 rounded-full border border-slate-700">
              {projects.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition duration-150"
            aria-label="Close history sidebar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-slate-800 bg-slate-950/40">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              type="text"
              placeholder="Search past docs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-4 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-hidden focus:border-slate-700 focus:ring-1 focus:ring-slate-700 transition duration-150 font-sans"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {filteredProjects.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 py-12">
              <FileText className="w-8 h-8 text-slate-700 mb-2" />
              <span className="text-xs">No saved docs found</span>
              <p className="text-[10px] text-slate-600 mt-1 max-w-[200px] text-center leading-relaxed">
                Start a new code session, generate a component, and tap "Save Doc" to build your history ledger.
              </p>
            </div>
          ) : (
            filteredProjects.map((project) => {
              const isActive = project.id === currentProjectId;
              return (
                <div
                  key={project.id}
                  className={`group relative rounded-xl border p-3.5 transition duration-200 cursor-pointer flex flex-col justify-between ${
                    isActive
                      ? "bg-slate-950/80 border-emerald-500/40 shadow-md shadow-emerald-500/5"
                      : "bg-slate-950/40 border-slate-800/80 hover:bg-slate-950/60 hover:border-slate-800"
                  }`}
                  onClick={() => {
                    onSelectProject(project);
                    onClose();
                  }}
                >
                  <div className="flex-1 min-w-0 pr-6">
                    <div className="flex items-center gap-1.5 mb-1">
                      <h4 className="font-semibold text-xs text-slate-200 truncate group-hover:text-emerald-400 transition duration-150">
                        {project.title}
                      </h4>
                      {isActive && (
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                      )}
                    </div>
                    <p className="text-[10px] text-slate-400 line-clamp-2 leading-relaxed mb-3">
                      {project.prompt}
                    </p>
                  </div>

                  {/* Footer Stats */}
                  <div className="flex items-center justify-between border-t border-slate-800/60 pt-2.5">
                    <div className="flex items-center gap-1 text-[10px] text-slate-500">
                      <Calendar className="w-3 h-3" />
                      <span>{formatDate(project.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteProject(project.id);
                        }}
                        className="p-1 rounded text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 transition duration-150"
                        title="Delete Doc"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-slate-400 transition duration-150" />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
