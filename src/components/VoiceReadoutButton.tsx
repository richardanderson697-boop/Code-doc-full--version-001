import React, { useState, useEffect } from "react";
import { Volume2, VolumeX, Square, Play, Sparkles } from "lucide-react";
import { speakText, stopSpeech, isSpeechActive } from "../utils/speechUtils";

interface VoiceReadoutButtonProps {
  textToSpeak: string;
  title?: string;
  line?: number;
  label?: string;
  size?: "sm" | "md" | "icon";
  className?: string;
}

export default function VoiceReadoutButton({
  textToSpeak,
  title,
  line,
  label,
  size = "sm",
  className = ""
}: VoiceReadoutButtonProps) {
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    // Sync with speech synthesis state interval
    const interval = setInterval(() => {
      if (!isSpeechActive() && isPlaying) {
        setIsPlaying(false);
      }
    }, 400);

    return () => clearInterval(interval);
  }, [isPlaying]);

  const handleTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (isPlaying) {
      stopSpeech();
      setIsPlaying(false);
      return;
    }

    // Build natural language narration for function / line readout
    let narration = "";
    if (title && line) {
      narration = `${title}, on line ${line}. ${textToSpeak}`;
    } else if (title) {
      narration = `${title}. ${textToSpeak}`;
    } else if (line) {
      narration = `Line ${line}. ${textToSpeak}`;
    } else {
      narration = textToSpeak;
    }

    setIsPlaying(true);
    speakText(narration, {
      onEnd: () => setIsPlaying(false),
      onError: () => setIsPlaying(false)
    });
  };

  if (size === "icon") {
    return (
      <button
        type="button"
        onClick={handleTogglePlay}
        className={`p-1.5 rounded-lg border transition duration-150 flex items-center justify-center cursor-pointer ${
          isPlaying
            ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-sm shadow-emerald-950/50 animate-pulse"
            : "bg-slate-900/80 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-emerald-400"
        } ${className}`}
        title={isPlaying ? "Stop Voice Readout" : "Read Function / Line in Natural Language"}
      >
        {isPlaying ? (
          <VolumeX className="w-3.5 h-3.5 text-emerald-300" />
        ) : (
          <Volume2 className="w-3.5 h-3.5" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleTogglePlay}
      className={`px-2 py-1 rounded-lg border text-[10px] font-mono font-medium flex items-center gap-1.5 transition duration-150 cursor-pointer ${
        isPlaying
          ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300 shadow-inner animate-pulse"
          : "bg-slate-950/80 hover:bg-slate-900 border-slate-800 text-slate-300 hover:text-emerald-400 hover:border-slate-700"
      } ${className}`}
      title={isPlaying ? "Stop Voice Readout" : "Listen to line-by-line explanation"}
    >
      {isPlaying ? (
        <>
          <Square className="w-3 h-3 text-emerald-400 fill-emerald-400" />
          <span>Stop Voice</span>
        </>
      ) : (
        <>
          <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
          <span>{label || "Read Voice"}</span>
        </>
      )}
    </button>
  );
}
