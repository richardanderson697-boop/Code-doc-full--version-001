import React, { useState, useEffect } from "react";
import { Copy, Check, Download, Terminal, Maximize2, Minimize2 } from "lucide-react";

interface CodeVisualizerProps {
  code: string;
  isGenerating: boolean;
  appName: string;
  highlightedLine?: number | null;
  onLineClick?: (line: number) => void;
}

export default function CodeVisualizer({ 
  code, 
  isGenerating, 
  appName,
  highlightedLine = null,
  onLineClick
}: CodeVisualizerProps) {
  const [copied, setCopied] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);

  // Auto-scroll to highlighted line
  useEffect(() => {
    if (highlightedLine !== null && highlightedLine !== undefined) {
      const element = document.getElementById(`code-line-row-${highlightedLine}`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [highlightedLine]);

  const handleCopy = () => {
    if (!code) return;
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!code) return;
    const blob = new Blob([code], { type: "text/typescript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${appName.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "app"}.tsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Custom high-performance, regex-based TSX/TS syntax highlighter
  const highlightLine = (line: string) => {
    if (!line.trim()) return <span>&nbsp;</span>;
    if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) {
      return <span className="text-slate-500 italic">{line}</span>;
    }

    const keywords = [
      "import", "from", "export", "default", "const", "function", "return", "let", 
      "class", "interface", "type", "true", "false", "null", "undefined", "await", 
      "async", "try", "catch", "throw", "new", "typeof", "as", "if", "else", "for", 
      "while", "switch", "case", "break", "continue"
    ];

    // Regex to split by strings, comments, words, or special TSX bracket symbols
    const tokenRegex = /(\/\/.*|"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|`(?:\\`|[^`])*`|\b\w+\b|[^\w\s])/g;
    const tokens = line.split(tokenRegex);

    return tokens.map((token, idx) => {
      if (!token) return null;

      // Inline Comments
      if (token.startsWith("//")) {
        return <span key={idx} className="text-slate-500 italic">{token}</span>;
      }
      // Strings
      if (
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'")) ||
        (token.startsWith("`") && token.endsWith("`"))
      ) {
        return <span key={idx} className="text-amber-200">{token}</span>;
      }
      // Keywords
      if (keywords.includes(token)) {
        return <span key={idx} className="text-sky-400 font-semibold">{token}</span>;
      }
      // Built-in React hooks
      if (token.startsWith("use") && token.length > 3 && token[3] === token[3].toUpperCase()) {
        return <span key={idx} className="text-teal-400 font-medium">{token}</span>;
      }
      // Component Names (Capitalized) or Types
      if (/^[A-Z][a-zA-Z0-9]*$/.test(token)) {
        return <span key={idx} className="text-emerald-400">{token}</span>;
      }
      // Numbers
      if (/^\d+$/.test(token)) {
        return <span key={idx} className="text-purple-400">{token}</span>;
      }
      // TSX/JSX brackets & structural symbols
      if (/^[{}()\[\];.,+\-*/%=&|^<>!~?:]+$/.test(token)) {
        return <span key={idx} className="text-slate-400">{token}</span>;
      }

      return <span key={idx} className="text-slate-200">{token}</span>;
    });
  };

  const lines = code ? code.split("\n") : [];

  return (
    <div 
      className={`flex flex-col bg-slate-950 border border-slate-800 rounded-xl overflow-hidden transition-all duration-300 ${
        isFullScreen ? "fixed inset-4 z-50 shadow-2xl" : "h-full flex-1"
      }`}
    >
      {/* Code Header Tab */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-emerald-400 animate-pulse" />
          <span className="font-mono text-xs text-slate-300 font-medium">
            App.tsx {isGenerating && <span className="text-teal-400 text-[10px] ml-2 font-sans animate-pulse">● writing...</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            disabled={!code}
            className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition duration-150 disabled:opacity-50"
            title="Copy Code"
            aria-label="Copy code to clipboard"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>
          <button
            onClick={handleDownload}
            disabled={!code}
            className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition duration-150 disabled:opacity-50"
            title="Download TSX"
            aria-label="Download code as TSX file"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsFullScreen(!isFullScreen)}
            className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition duration-150"
            title={isFullScreen ? "Minimize" : "Maximize"}
            aria-label={isFullScreen ? "Exit full screen" : "Enter full screen"}
          >
            {isFullScreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Code Body */}
      <div className="flex-1 overflow-auto font-mono text-sm leading-relaxed p-4 select-text">
        {lines.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 py-12">
            <span className="text-xs">Awaiting prompt submission...</span>
          </div>
        ) : (
          <div className="flex min-w-full">
            {/* Line numbers gutter & highlighted lines */}
            <div className="flex-1 space-y-1 text-xs">
              {lines.map((line, idx) => {
                const lineNum = idx + 1;
                const isLineHighlighted = highlightedLine === lineNum;
                
                return (
                  <div 
                    key={idx} 
                    id={`code-line-row-${lineNum}`}
                    onClick={() => onLineClick && onLineClick(lineNum)}
                    className={`flex items-center min-w-full group cursor-pointer border-l-2 py-0.5 transition-colors duration-150 ${
                      isLineHighlighted 
                        ? "bg-emerald-500/10 border-emerald-400 shadow-md shadow-emerald-500/5" 
                        : "border-transparent hover:bg-slate-900/40"
                    }`}
                  >
                    {/* Line Number gutter element inside row */}
                    <div className={`w-10 text-right select-none pr-3 mr-3 text-xs font-light border-r ${
                      isLineHighlighted 
                        ? "text-emerald-400 border-emerald-500/30 font-semibold" 
                        : "text-slate-600 border-slate-800/80 group-hover:text-slate-400"
                    }`}>
                      {lineNum}
                    </div>
                    {/* Highlighted text block */}
                    <pre className={`flex-1 whitespace-pre pr-4 ${isLineHighlighted ? "text-slate-100 font-medium" : "text-slate-200"}`}>
                      {highlightLine(line)}
                    </pre>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
