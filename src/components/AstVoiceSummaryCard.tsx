import React, { useState, useEffect, useMemo } from "react";
import { Volume2, VolumeX, Play, Square, Sparkles, AlertTriangle, ShieldAlert, CheckCircle2, Zap, Radio, Activity } from "lucide-react";
import { speakText, stopSpeech, isSpeechActive, buildAstAudioSummaryText } from "../utils/speechUtils";

interface AstVoiceSummaryCardProps {
  completenessScore: number;
  totalFiles?: number;
  totalLines?: number;
  overallSummary?: string;
  sanityChecks?: Array<{
    type: "success" | "warning" | "info" | "critical";
    title: string;
    message: string;
    line?: number;
  }>;
  missingFeatures?: Array<{
    feature: string;
    category?: string;
    reason?: string;
  }>;
  categoryScores?: Record<string, any>;
  autoPlay?: boolean;
}

export default function AstVoiceSummaryCard({
  completenessScore,
  totalFiles,
  totalLines,
  overallSummary,
  sanityChecks = [],
  missingFeatures = [],
  categoryScores,
  autoPlay = false
}: AstVoiceSummaryCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [speechRate, setSpeechRate] = useState<number>(1.0);
  const [showScript, setShowScript] = useState(false);

  // Calculate severity counts
  const severityCounts = useMemo(() => {
    let critical = 0;
    let warning = 0;
    let info = 0;
    let success = 0;

    sanityChecks.forEach(c => {
      if (c.type === "critical") critical++;
      else if (c.type === "warning") warning++;
      else if (c.type === "info") info++;
      else if (c.type === "success") success++;
    });

    return { critical, warning, info, success };
  }, [sanityChecks]);

  // Generate complete audio script
  const fullScript = useMemo(() => {
    return buildAstAudioSummaryText({
      completenessScore,
      totalFiles,
      totalLines,
      overallSummary,
      sanityChecks,
      missingFeatures,
      categoryScores
    });
  }, [completenessScore, totalFiles, totalLines, overallSummary, sanityChecks, missingFeatures, categoryScores]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isSpeechActive() && isPlaying) {
        setIsPlaying(false);
      }
    }, 400);

    return () => clearInterval(interval);
  }, [isPlaying]);

  // Handle Play/Stop speech
  const handleToggleSpeech = () => {
    if (isPlaying) {
      stopSpeech();
      setIsPlaying(false);
      return;
    }

    setIsPlaying(true);
    speakText(fullScript, {
      rate: speechRate,
      onEnd: () => setIsPlaying(false),
      onError: () => setIsPlaying(false)
    });
  };

  return (
    <div className="bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950/40 border border-indigo-500/30 rounded-2xl p-4 sm:p-5 space-y-4 shadow-xl relative overflow-hidden">
      
      {/* Decorative accent glow */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 rounded-full blur-2xl pointer-events-none" />

      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-indigo-500/20 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 rounded-xl shrink-0">
            <Radio className={`w-5 h-5 ${isPlaying ? "animate-pulse text-emerald-400" : "text-indigo-400"}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-bold text-xs text-slate-100 uppercase tracking-wider font-sans">
                Stage 2 Voice Summary
              </h4>
              <span className="px-2 py-0.5 rounded text-[9px] font-mono font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                Audible AST Analysis
              </span>
            </div>
            <p className="text-[10px] text-slate-400 font-sans mt-0.5">
              Audibly describes AST score, overall grade, and alerts you to flagged issues by severity level
            </p>
          </div>
        </div>

        {/* Speed Selector */}
        <div className="flex items-center gap-1.5 self-start sm:self-auto">
          <span className="text-[10px] text-slate-400 font-mono">Speed:</span>
          {[0.9, 1.0, 1.2, 1.4].map(rate => (
            <button
              key={rate}
              onClick={() => {
                setSpeechRate(rate);
                if (isPlaying) {
                  stopSpeech();
                  setIsPlaying(false);
                }
              }}
              className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium transition ${
                speechRate === rate
                  ? "bg-indigo-500 text-white font-bold"
                  : "bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800"
              }`}
            >
              {rate}x
            </button>
          ))}
        </div>
      </div>

      {/* Badges Overview: Completion Score + Severity Alert Counts */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 select-none">
        
        {/* AST Completion Score Badge */}
        <div className="col-span-2 sm:col-span-1 p-2.5 bg-slate-950/80 border border-indigo-500/30 rounded-xl text-center flex flex-col justify-between">
          <span className="text-[9px] font-mono uppercase font-bold text-slate-400">AST Score</span>
          <div className="flex items-baseline justify-center gap-1 my-0.5">
            <span className={`text-xl font-extrabold font-mono ${
              completenessScore >= 80 ? "text-emerald-400" : completenessScore >= 50 ? "text-amber-400" : "text-rose-400"
            }`}>
              {completenessScore}
            </span>
            <span className="text-xs text-slate-500 font-mono">/100</span>
          </div>
          <span className="text-[8px] text-indigo-300 font-mono">Stage 2 Audited</span>
        </div>

        {/* Critical Alerts Count */}
        <div className={`p-2.5 rounded-xl border flex flex-col justify-between text-center ${
          severityCounts.critical > 0
            ? "bg-rose-950/40 border-rose-500/40 text-rose-300"
            : "bg-slate-950/40 border-slate-850 text-slate-500"
        }`}>
          <span className="text-[9px] font-mono uppercase font-bold flex items-center justify-center gap-1">
            <ShieldAlert className="w-3 h-3 text-rose-400" /> Critical
          </span>
          <span className="text-lg font-bold font-mono my-0.5">{severityCounts.critical}</span>
          <span className="text-[8px] opacity-80">Severe Traps</span>
        </div>

        {/* Warning Alerts Count */}
        <div className={`p-2.5 rounded-xl border flex flex-col justify-between text-center ${
          severityCounts.warning > 0
            ? "bg-amber-950/40 border-amber-500/40 text-amber-300"
            : "bg-slate-950/40 border-slate-850 text-slate-500"
        }`}>
          <span className="text-[9px] font-mono uppercase font-bold flex items-center justify-center gap-1">
            <AlertTriangle className="w-3 h-3 text-amber-400" /> Warnings
          </span>
          <span className="text-lg font-bold font-mono my-0.5">{severityCounts.warning}</span>
          <span className="text-[8px] opacity-80">State Risks</span>
        </div>

        {/* Info Notes Count */}
        <div className={`p-2.5 rounded-xl border flex flex-col justify-between text-center ${
          severityCounts.info > 0
            ? "bg-sky-950/40 border-sky-500/40 text-sky-300"
            : "bg-slate-950/40 border-slate-850 text-slate-500"
        }`}>
          <span className="text-[9px] font-mono uppercase font-bold flex items-center justify-center gap-1">
            <Zap className="w-3 h-3 text-sky-400" /> Info / Notes
          </span>
          <span className="text-lg font-bold font-mono my-0.5">{severityCounts.info}</span>
          <span className="text-[8px] opacity-80">Placeholders</span>
        </div>

        {/* Clean Architecture Count */}
        <div className={`p-2.5 rounded-xl border flex flex-col justify-between text-center ${
          severityCounts.success > 0
            ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-300"
            : "bg-slate-950/40 border-slate-850 text-slate-500"
        }`}>
          <span className="text-[9px] font-mono uppercase font-bold flex items-center justify-center gap-1">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Verified
          </span>
          <span className="text-lg font-bold font-mono my-0.5">{severityCounts.success}</span>
          <span className="text-[8px] opacity-80">Clean React</span>
        </div>
      </div>

      {/* Main Play Voice Summary Action Button & Soundwave Visualizer */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={handleToggleSpeech}
          className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-3 transition-all duration-200 cursor-pointer shadow-lg ${
            isPlaying
              ? "bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white border border-emerald-400/50 ring-2 ring-emerald-500/30"
              : "bg-gradient-to-r from-indigo-600 to-emerald-600 hover:from-indigo-500 hover:to-emerald-500 text-white border border-indigo-400/30"
          }`}
        >
          {isPlaying ? (
            <>
              <Square className="w-4 h-4 text-white fill-white animate-pulse" />
              <span className="font-mono uppercase tracking-wider">Stop Audio Summary</span>
              {/* Soundwave Animation Bars */}
              <div className="flex items-center gap-1 ml-2">
                <span className="w-1 h-4 bg-white rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1 h-6 bg-white rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1 h-3 bg-white rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                <span className="w-1 h-5 bg-white rounded-full animate-bounce" style={{ animationDelay: "450ms" }} />
              </div>
            </>
          ) : (
            <>
              <Volume2 className="w-4 h-4 text-emerald-300" />
              <span className="font-mono uppercase tracking-wider">Audibly Describe AST Score & Flagged Issues</span>
            </>
          )}
        </button>

        <div className="flex items-center justify-between px-1 text-[10px] text-slate-400 font-mono">
          <span>Voice Narrator: Clean English Synthesis</span>
          <button
            type="button"
            onClick={() => setShowScript(!showScript)}
            className="hover:text-indigo-300 underline cursor-pointer"
          >
            {showScript ? "Hide Spoken Script" : "View Spoken Script"}
          </button>
        </div>

        {showScript && (
          <div className="p-3 bg-slate-950 border border-indigo-500/20 rounded-xl text-xs text-slate-300 leading-relaxed font-sans space-y-1.5 select-text">
            <span className="text-[9px] uppercase font-bold tracking-wider text-indigo-400 font-mono block">
              Generated Audio Script Preview:
            </span>
            <p className="italic text-slate-300 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800">
              "{fullScript}"
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
