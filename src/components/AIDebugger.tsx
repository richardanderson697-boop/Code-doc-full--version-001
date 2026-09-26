import React, { useState, useRef, useEffect } from "react";
import { apiFetch, notifyBalance } from "../utils/apiFetch";
import { Bug, Send, Sparkles, Terminal, ShieldAlert, Cpu, AlertCircle, RefreshCw, CheckCircle2 } from "lucide-react";
import VoiceReadoutButton from "./VoiceReadoutButton";

interface AIDebuggerProps {
  code: string;
  onHighlightLine: (line: number) => void;
  selectedLine: number | null;
}

interface Message {
  id: string;
  sender: "user" | "ai";
  text: string;
  timestamp: Date;
}

export default function AIDebugger({ code, onHighlightLine, selectedLine }: AIDebuggerProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "initial",
      sender: "ai",
      text: "Hey! I am your Code Doc Debugger. Select a line in the editor or select any variable or hook on the Anatomy tab. If there is a bug or behavior you don't understand, describe it here and I will tell you what went wrong and how the state flows!",
      timestamp: new Date()
    }
  ]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isThinking]);

  const lastSelectedLineRef = useRef<number | null>(null);

  // Handle automated triggers when user selects a line
  useEffect(() => {
    if (selectedLine && selectedLine !== lastSelectedLineRef.current) {
      lastSelectedLineRef.current = selectedLine;
      const codeLines = code.split("\n");
      const targetLineText = codeLines[selectedLine - 1]?.trim() || "";
      
      const debugPrompt = `Analyze line ${selectedLine} in the component: "${targetLineText}". Give me a quick layperson explanation of what this line does, its inputs/outputs, and check if there are any risks or bugs.`;
      
      // Let's add a message offering quick info about the selected line
      setMessages(prev => [
        ...prev,
        {
          id: `line-selection-${Date.now()}`,
          sender: "user",
          text: `🔍 [Inspect Line ${selectedLine}]: "${targetLineText}"`,
          timestamp: new Date()
        }
      ]);
      
      void handleDebugRequest(debugPrompt, `Line ${selectedLine} Inspection: "${targetLineText}"`);
    } else if (!selectedLine) {
      lastSelectedLineRef.current = null;
    }
  }, [selectedLine]);

  const handleDebugRequest = async (debugQuery: string, userFacingText: string) => {
    setIsThinking(true);
    try {
      const response = await apiFetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: "You are the ultimate friendly React Code Doc Debugger designed for non-technical creators. Explain React rendering, state flow, line-by-line code logic, and syntax issues. Keep your answer clear, encouraging, structured, and easy to read. Use bullet points and bold styling. Avoid complex developer jargon unless you explain it simply.",
          prompt: `Here is the full React TSX component code:
\`\`\`tsx
${code}
\`\`\`

User question or action context:
${debugQuery}

Output format:
====PURPOSE====
Explain clearly in structural bullet points what the code line/element does, where values flow, why it was written, and what might go wrong. Highlight recommendations for non-coders.

====CODE====
If there is a bug or correction, provide the exact corrected code block. If no bugs or corrections are needed, just output a simple comment like:
// No code edits needed! Your current component logic is fully correct.`
        })
      });


      if (!response.body) {
        throw new Error("No response body received from server debugger");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let finished = false;
      let accumulatedText = "";
      let buffer = "";

      // Create a temporary AI message block to fill in as stream receives tokens
      const messageId = `ai-thinking-${Date.now()}`;
      setMessages(prev => [
        ...prev,
        {
          id: messageId,
          sender: "ai",
          text: "Analyzing code, variables, and states...",
          timestamp: new Date()
        }
      ]);

      while (!finished) {
        const { value, done } = await reader.read();
        finished = done;
        if (value) {
          buffer += decoder.decode(value, { stream: !finished });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

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
                  
                  // Extract the purpose/explanation section from split tags
                  const purposeMarker = "====PURPOSE====";
                  const codeMarker = "====CODE====";
                  let parsedAnswer = accumulatedText;

                  if (accumulatedText.includes(purposeMarker)) {
                    if (accumulatedText.includes(codeMarker)) {
                      const purposePart = accumulatedText.substring(accumulatedText.indexOf(purposeMarker) + purposeMarker.length, accumulatedText.indexOf(codeMarker)).trim();
                      const codePart = accumulatedText.substring(accumulatedText.indexOf(codeMarker) + codeMarker.length).trim();
                      
                      parsedAnswer = purposePart;
                      if (codePart && !codePart.includes("No code edits needed")) {
                        parsedAnswer += `\n\n### Suggested Correction:\n\`\`\`tsx\n${codePart}\n\`\`\``;
                      }
                    } else {
                      parsedAnswer = accumulatedText.substring(accumulatedText.indexOf(purposeMarker) + purposeMarker.length).trim();
                    }
                  }

                  setMessages(prev =>
                    prev.map(msg =>
                      msg.id === messageId ? { ...msg, text: parsedAnswer } : msg
                    )
                  );
                }
              } catch (e) {
                // Ignore parsing errors
              }
            }
          }
        }
      }
    } catch (error: any) {
      setMessages(prev => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          sender: "ai",
          text: `Debugger connection failed: ${error.message || "An unexpected issue occurred while requesting AI debugging scan."}`,
          timestamp: new Date()
        }
      ]);
    } finally {
      setIsThinking(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isThinking) return;

    const userText = input;
    setMessages(prev => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        sender: "user",
        text: userText,
        timestamp: new Date()
      }
    ]);
    setInput("");
    void handleDebugRequest(userText, userText);
  };

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden h-full flex-1">
      {/* Panel Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Bug className="w-4 h-4 text-rose-400" />
          <span className="text-xs font-semibold text-slate-200">AI Code Debugger</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px]">
          <Cpu className="w-3 h-3" /> State Analyst
        </div>
      </div>

      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 select-text">
        {messages.map((msg) => {
          const isAi = msg.sender === "ai";
          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isAi ? "items-start" : "items-end"}`}
            >
              <div
                className={`max-w-[90%] rounded-xl px-4 py-3 text-xs leading-relaxed ${
                  isAi
                    ? "bg-slate-950/80 border border-slate-800 text-slate-300 rounded-bl-none"
                    : "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded-br-none"
                }`}
              >
                {isAi && (
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-900/80">
                    <span className="text-[10px] font-mono font-bold text-slate-500 flex items-center gap-1">
                      <Sparkles className="w-3 h-3 text-rose-400" /> Explanation
                    </span>
                    <VoiceReadoutButton title="AI Code Explanation" textToSpeak={msg.text} label="Listen Explanation" />
                  </div>
                )}
                {/* Parse basic bold/inline markdown tags in chat messages */}
                <div className="space-y-2 whitespace-pre-wrap">
                  {msg.text.split("\n").map((line, idx) => {
                    let cleanLine = line;
                    // Detect custom subheadings in AI chats
                    if (cleanLine.startsWith("### ")) {
                      return <h4 key={idx} className="font-semibold text-emerald-400 text-xs mt-3 mb-1.5">{cleanLine.slice(4)}</h4>;
                    }
                    if (cleanLine.startsWith("- ") || cleanLine.startsWith("* ")) {
                      return <li key={idx} className="list-disc ml-4 font-light text-slate-300">{cleanLine.slice(2)}</li>;
                    }
                    return <p key={idx} className="font-light">{cleanLine}</p>;
                  })}
                </div>
              </div>
              <span className="text-[9px] text-slate-600 mt-1 font-mono">
                {msg.timestamp.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </span>
            </div>
          );
        })}
        {isThinking && (
          <div className="flex items-start">
            <div className="bg-slate-950/80 border border-slate-800 text-slate-500 rounded-xl rounded-bl-none px-4 py-3 text-xs flex items-center gap-2 animate-pulse">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-rose-400" />
              <span>Analyzing variables & compiling fix paths...</span>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-slate-800 bg-slate-950/40">
        <div className="flex items-center gap-2 bg-slate-950 rounded-xl border border-slate-800 px-3 py-1.5 focus-within:border-slate-700 transition duration-150">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isThinking}
            placeholder={selectedLine ? `Ask about line ${selectedLine}...` : "E.g., 'What does line 25 do?' or 'How does activeTab update?'"}
            className="flex-1 bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-hidden py-1.5"
          />
          <button
            type="submit"
            disabled={!input.trim() || isThinking}
            className="p-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:bg-slate-900 disabled:opacity-50 text-emerald-400 transition duration-150"
            aria-label="Send debugger question"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
}
