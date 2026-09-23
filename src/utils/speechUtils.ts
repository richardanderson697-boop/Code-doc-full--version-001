/**
 * Speech synthesis utility providing natural language voice readout
 * for code functions, line-by-line descriptions, and AST score summaries.
 */

export interface SpeechOptions {
  rate?: number;
  pitch?: number;
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: any) => void;
}

let currentUtterance: SpeechSynthesisUtterance | null = null;

/**
 * Strips markdown formatting (**, ##, `, bullets, code fences) into smooth spoken prose.
 */
export function cleanTextForSpeech(text: string): string {
  if (!text) return "";
  
  return text
    .replace(/====.*?====/g, "") // Remove section tags like ====PURPOSE====
    .replace(/#+\s*/g, "") // Remove heading hashes
    .replace(/\*\*(.*?)\*\*/g, "$1") // Bold text to plain
    .replace(/`(.*?)`/g, "$1") // Code blocks to plain
    .replace(/```[\s\S]*?```/g, "Code block omitted.") // Multi-line code fences
    .replace(/^[-*]\s+/gm, "") // Bullet points
    .replace(/^\d+\.\s+/gm, "") // Numbered lists
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();
}

/**
 * Speaks text out loud using browser window.speechSynthesis.
 */
export function speakText(text: string, options: SpeechOptions = {}): SpeechSynthesisUtterance | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    console.warn("Speech synthesis is not supported in this browser environment.");
    if (options.onError) options.onError("Speech synthesis unsupported");
    return null;
  }

  // Cancel any ongoing speech before starting new utterance
  window.speechSynthesis.cancel();

  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) {
    if (options.onEnd) options.onEnd();
    return null;
  }

  const utterance = new SpeechSynthesisUtterance(cleaned);
  utterance.rate = options.rate ?? 1.0;
  utterance.pitch = options.pitch ?? 1.0;
  utterance.volume = options.volume ?? 1.0;

  // Try selecting a natural English voice if available
  const voices = window.speechSynthesis.getVoices();
  const englishVoice = voices.find(
    v => v.lang.startsWith("en") && (v.name.includes("Natural") || v.name.includes("Google") || v.name.includes("Samantha") || v.name.includes("Daniel") || v.name.includes("Karen") || v.name.includes("Alex"))
  ) || voices.find(v => v.lang.startsWith("en"));

  if (englishVoice) {
    utterance.voice = englishVoice;
  }

  utterance.onstart = () => {
    currentUtterance = utterance;
    if (options.onStart) options.onStart();
  };

  utterance.onend = () => {
    currentUtterance = null;
    if (options.onEnd) options.onEnd();
  };

  utterance.onerror = (e) => {
    currentUtterance = null;
    if (options.onError) options.onError(e);
  };

  window.speechSynthesis.speak(utterance);
  return utterance;
}

/**
 * Stops any active speech synthesis.
 */
export function stopSpeech(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    currentUtterance = null;
  }
}

/**
 * Pauses active speech.
 */
export function pauseSpeech(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.pause();
  }
}

/**
 * Resumes paused speech.
 */
export function resumeSpeech(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.resume();
  }
}

/**
 * Checks if speech synthesis is currently speaking or paused.
 */
export function isSpeechActive(): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  return window.speechSynthesis.speaking;
}

/**
 * Constructs a human-sounding audio narrative for the Stage 2 AST completion score & flagged issues.
 */
export function buildAstAudioSummaryText(params: {
  completenessScore: number;
  totalFiles?: number;
  totalLines?: number;
  overallSummary?: string;
  missingFeatures?: Array<{ feature: string; category?: string; reason?: string }>;
  sanityChecks?: Array<{ type: string; title: string; message: string; line?: number }>;
  categoryScores?: Record<string, any>;
}): string {
  const { completenessScore, totalFiles, totalLines, overallSummary, missingFeatures, sanityChecks, categoryScores } = params;

  let script = `AST Code Completion Report. `;
  
  // 1. AST Completion Score
  script += `The overall AST completion score is ${completenessScore} out of 100. `;
  if (completenessScore >= 80) {
    script += `This reflects a robust and high-grade architecture. `;
  } else if (completenessScore >= 50) {
    script += `The application shell is functional, but core logic contains open placeholders or missing handlers. `;
  } else {
    script += `Critical warning: The application is largely incomplete or contains interrupted code blocks. `;
  }

  if (totalFiles && totalLines) {
    script += `The workspace contains ${totalFiles} files spanning ${totalLines} total lines of code. `;
  }

  // 2. Summary
  if (overallSummary) {
    script += `Summary overview: ${overallSummary}. `;
  }

  // 3. Flagged Issues & Severity Levels
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  const issueMessages: string[] = [];

  if (sanityChecks && sanityChecks.length > 0) {
    sanityChecks.forEach(check => {
      if (check.type === "critical") {
        criticalCount++;
        issueMessages.push(`Critical severity alert: ${check.title}. ${check.message}`);
      } else if (check.type === "warning") {
        warningCount++;
        issueMessages.push(`Warning severity: ${check.title} at line ${check.line || "unknown"}. ${check.message}`);
      } else if (check.type === "info") {
        infoCount++;
        issueMessages.push(`Info note: ${check.title}. ${check.message}`);
      }
    });
  }

  if (issueMessages.length > 0) {
    script += `Alerting flagged issues by severity level: `;
    if (criticalCount > 0) {
      script += `${criticalCount} critical severity alerts detected! `;
    }
    if (warningCount > 0) {
      script += `${warningCount} warnings flagged. `;
    }
    if (infoCount > 0) {
      script += `${infoCount} informational items noted. `;
    }
    script += issueMessages.join(". ") + ". ";
  } else {
    script += `No critical architectural issues or state mutation traps were flagged. `;
  }

  // 4. Missing features or open gaps
  if (missingFeatures && missingFeatures.length > 0) {
    script += `Intended or missing production features include: ${missingFeatures.slice(0, 3).map(m => m.feature).join(", ")}. `;
  }

  return script;
}
