// FinalRead stakeholder overlay: the business-UI view of an audit result for
// a non-technical decision maker. Everything on screen is built from the real
// audit result via shared/finalread-report.ts — no code, no file paths, no
// diffs on this surface. Plain Tailwind utilities (no global CSS), so the
// overlay cannot affect the rest of the app.
//
// Print: the overlay is portaled to document.body, and index.css hides #root
// in print while this view is open, so printing yields only the report.
// Collapsed sections and item detail render hidden on screen but visible in
// print (hidden print:block), so the PDF always carries every explanation
// with no click required. The Q&A section is never printed.
import { useState, useMemo, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  X,
  ChevronDown,
  Mic,
  Volume2,
  Square,
  Download,
  AlertTriangle,
  CheckCircle2,
  FileWarning,
  ShieldQuestion,
  MessageCircle,
  FileText,
  Printer,
} from "lucide-react";
import { apiFetch } from "../../utils/apiFetch";
import { speakText, stopSpeech } from "../../utils/speechUtils";
import {
  buildFinalReadReport,
  type FinalReadAuditInput,
  type FinalReadBucketItem,
} from "../../../shared/finalread-report";
import {
  renderMultiFindingPacket,
  type DevHandoffFinding,
} from "../../../shared/dev-handoff-packet";

/** Convert the workspace intelligence result into the overlay's audit input.
 *  Exported so the host panel (IntelligenceReport) can build it. */
export function intelResultToFinalReadInput(
  intelResult: any,
  projectTitle?: string
): FinalReadAuditInput {
  const preflight = intelResult?.preflight;
  // Deterministic per-category evidence lines (already persisted by the
  // intelligence route as deterministicAssessment.evidence). Guarded: only
  // a plain object of string arrays passes through.
  const rawEvidence = intelResult?.deterministicAssessment?.evidence;
  const categoryEvidence: Record<string, string[]> | undefined =
    rawEvidence && typeof rawEvidence === "object" && !Array.isArray(rawEvidence)
      ? rawEvidence
      : undefined;
  // Warehouse detail for the Q&A: the intelligence run's application map
  // and per-file ledger. The overlay never renders these — they ride along
  // so the server-side Q&A context can retrieve what the analysis
  // established about how the app is wired. Guarded like the evidence
  // above: only the expected container shapes pass through; the report
  // builder sanitizes entry-level detail. (The raw category reasons need
  // no separate handling — they already ride inside categoryScores.)
  const applicationMap =
    intelResult?.applicationMap &&
    typeof intelResult.applicationMap === "object" &&
    !Array.isArray(intelResult.applicationMap)
      ? intelResult.applicationMap
      : undefined;
  const fileLedger = Array.isArray(intelResult?.fileLedger)
    ? intelResult.fileLedger
    : undefined;
  // Header identity chain (first present wins): a caller-supplied title
  // (the buyer entry's owner/repo or ZIP name) always wins; then the
  // README H1 the server derived; then the recorded import source. The
  // builder's "Reviewed project" remains the last resort only.
  const cleanTitle = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const importSource = intelResult?.importSource;
  const importTitle =
    importSource?.kind === "github" &&
    importSource?.owner &&
    importSource?.repo
      ? `${importSource.owner}/${importSource.repo}`
      : importSource?.kind === "zip" &&
          typeof importSource?.filename === "string" &&
          importSource.filename.trim()
        ? importSource.filename.replace(/\.zip$/i, "")
        : undefined;
  const resolvedTitle =
    cleanTitle(projectTitle) ||
    cleanTitle(intelResult?.displayName) ||
    importTitle ||
    undefined;
  return {
    projectTitle: resolvedTitle,
    completenessScore: Number(intelResult?.completenessScore) || 0,
    applicationSummary:
      intelResult?.overallSummary || intelResult?.readmeTagline || undefined,
    categoryScores: intelResult?.categoryScores || {},
    categoryEvidence,
    applicationMap,
    fileLedger,
    findings: (preflight?.findings || []).map((f: any) => ({
      severity: f.severity,
      title: f.title,
      file: f.file,
      line: f.line,
      probe: f.probe,
      evidence: f.evidence,
      remediation: f.remediation,
      // The verification guard routes on this flag: dropping it here
      // would send delegated findings to liabilities on the client even
      // though the server routes them to needsVerification.
      unverified: f.unverified,
    })),
    missingFeatures: intelResult?.missingFeatures || [],
    scanGaps: preflight
      ? {
          failed: preflight.failed,
          probeFailures: preflight.probeFailures,
          filesSkipped: preflight.filesSkipped,
          filesScanned: preflight.filesScanned,
        }
      : undefined,
  };
}

const STARTER_QUESTIONS = [
  "Is this app actually finished?",
  "What's the biggest risk?",
  "Is the login and authentication real?",
  "What should be fixed first?",
  "What still needs verifying?",
];

type QaPhase = "idle" | "loading" | "done" | "error";

function itemKey(item: FinalReadBucketItem): string {
  return `${item.file}:${item.line}:${item.title}`;
}

function downloadMarkdown(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function BucketSection({
  title,
  icon,
  items,
  accent,
  defaultOpen,
  subtitle,
  renderDetail,
}: {
  title: string;
  icon: ReactNode;
  items: FinalReadBucketItem[];
  accent: string;
  defaultOpen: boolean;
  subtitle?: string;
  renderDetail?: (item: FinalReadBucketItem) => ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          {icon}
          {title}
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${accent}`}>
            {items.length}
          </span>
        </span>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 transition-transform print:hidden ${open ? "rotate-180" : ""}`}
        />
      </button>
      {/* Print: collapsed sections render hidden on screen but visible in
          print, so the PDF always carries every section. */}
      <div className={`px-4 pb-3 space-y-2 ${open ? "" : "hidden print:block"}`}>
        {subtitle && (
          <p className="text-xs text-slate-500 leading-relaxed">{subtitle}</p>
        )}
        {items.length === 0 && (
          <p className="text-xs text-slate-500">Nothing in this bucket.</p>
        )}
        {items.map((item) => {
          const key = itemKey(item);
          const isOpen = expandedItem === key;
          return (
            <div key={key} className="border border-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setExpandedItem(isOpen ? null : key)}
                className="w-full text-left px-3 py-2 text-[13px] font-medium text-slate-700"
              >
                {item.title}
              </button>
              {/* Print: collapsed item detail renders hidden on screen but
                  visible in print, so the PDF carries every explanation
                  with no click required. */}
              <div className={isOpen ? "" : "hidden print:block"}>
                {renderDetail ? (
                  <div className="px-3 pb-3 space-y-2">{renderDetail(item)}</div>
                ) : (
                  <p className="px-3 pb-3 text-[13px] text-slate-600 leading-relaxed">
                    {item.businessImplication}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function FinalReadOverlay({
  audit,
  onClose,
}: {
  audit: FinalReadAuditInput;
  onClose: () => void;
}) {
  const report = useMemo(() => buildFinalReadReport(audit), [audit]);

  // Q&A state
  const [question, setQuestion] = useState("");
  const [qaPhase, setQaPhase] = useState<QaPhase>("idle");
  const [qaAnswer, setQaAnswer] = useState("");
  const [qaDeclined, setQaDeclined] = useState(false);
  const [qaError, setQaError] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);

  // Handoff state: liability findings with a file location, all checked.
  const handoffItems = useMemo(
    // Liabilities plus half-built items: a 50/100 app's value to a developer
    // is mostly in what's half-built or missing, not just file-anchored
    // security findings. File-less items render without an anchor.
    () => [...report.liabilities, ...report.halfBuilt],
    [report]
  );
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(handoffItems.map(itemKey))
  );

  // Lock body scroll + close on Escape while the overlay is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Print hook: index.css uses this class to release the scroll lock and
    // hide the app root while printing, so only the report prints.
    document.body.classList.add("finalread-overlay-open");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.body.classList.remove("finalread-overlay-open");
      window.removeEventListener("keydown", onKey);
      stopSpeech();
    };
  }, [onClose]);

  const recognitionSupported =
    typeof window !== "undefined" &&
    ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  const askQuestion = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || qaPhase === "loading") return;
    setQaPhase("loading");
    setQaError("");
    setQaAnswer("");
    setQaDeclined(false);
    stopSpeech();
    setSpeaking(false);
    try {
      const res = await apiFetch("/api/finalread/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, audit }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not get an answer.");
      setQaAnswer(String(data.answer || ""));
      setQaDeclined(!!data.declined);
      setQaPhase("done");
    } catch (err: any) {
      setQaError(err?.message || "Could not get an answer.");
      setQaPhase("error");
    }
  };

  const toggleSpeak = () => {
    if (speaking) {
      stopSpeech();
      setSpeaking(false);
      return;
    }
    const utterance = speakText(qaAnswer);
    if (utterance) {
      setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
    }
  };

  const startListening = () => {
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR || listening) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      setQuestion(e.results[0][0].transcript);
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  };

  const toggleChecked = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const exportHandoff = () => {
    const selected = handoffItems.filter((i) => checked.has(itemKey(i)));
    if (selected.length === 0) return;
    const markdown = renderMultiFindingPacket({
      product: "FinalRead",
      items: selected.map((item) => {
        const finding: DevHandoffFinding = {
          title: item.title,
          message: item.businessImplication,
          severity: item.severity,
          type: report.liabilities.includes(item)
            ? "FinalRead liability"
            : "FinalRead half-built",
          file: item.file,
          line: item.line,
          suggestion: item.remediation,
        };
        return { finding };
      }),
      includedCount: selected.length,
      totalCount: handoffItems.length,
      generatedAt: new Date().toISOString(),
    });
    downloadMarkdown(`finalread-handoff-${selected.length}-findings.md`, markdown);
  };

  const scoreColor =
    report.completenessScore >= 80
      ? "text-emerald-600"
      : report.completenessScore >= 50
        ? "text-amber-600"
        : "text-rose-600";

  // Portaled to document.body so print CSS can hide the app root (#root)
  // while printing and leave only this report on the page.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-4 print:static print:block print:overflow-visible print:bg-white print:p-0">
      <div className="w-full max-w-3xl my-8 bg-slate-50 rounded-2xl shadow-2xl overflow-hidden print:max-w-none print:my-0 print:rounded-none print:shadow-none print:overflow-visible">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 bg-white border-b border-slate-200">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-indigo-600">
              FinalRead stakeholder view
            </p>
            <h2 className="text-xl font-bold text-slate-900 mt-1">
              {report.projectTitle}
            </h2>
            {report.applicationSummary && (
              <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                {report.applicationSummary}
              </p>
            )}
            <p className="text-sm text-slate-500 mt-0.5">
              Completeness{" "}
              <span className={`font-bold ${scoreColor}`}>
                {report.completenessScore}/100
              </span>
            </p>
            <p className="hidden print:block text-sm text-slate-500 mt-0.5">
              Report generated{" "}
              {new Date(report.generatedAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center gap-2 print:hidden">
            <button
              type="button"
              onClick={() => window.print()}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-white hover:bg-slate-700"
            >
              <Printer className="w-4 h-4" />
              Print / Save PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close stakeholder view"
              className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Verdict */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1">
              The verdict, in plain English
            </p>
            <p className="text-[15px] text-slate-800 leading-relaxed">{report.verdict}</p>
          </div>

          {/* Buckets */}
          <BucketSection
            title="What's working"
            icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />}
            items={report.working}
            accent="bg-emerald-100 text-emerald-700"
            defaultOpen={false}
          />
          <BucketSection
            title="What's half-built"
            icon={<FileWarning className="w-4 h-4 text-amber-600" />}
            items={report.halfBuilt}
            accent="bg-amber-100 text-amber-700"
            defaultOpen={false}
          />
          <BucketSection
            title="Liabilities — read these first"
            icon={<AlertTriangle className="w-4 h-4 text-rose-600" />}
            items={report.liabilities}
            accent="bg-rose-100 text-rose-700"
            defaultOpen={true}
          />
          {/* Needs developer verification — flagged, not established.
              Default-open like liabilities (it needs a human), with a
              distinct violet accent so it never reads as a liability. */}
          <BucketSection
            title="Needs developer verification"
            icon={<ShieldQuestion className="w-4 h-4 text-violet-600" />}
            items={report.needsVerification}
            accent="bg-violet-100 text-violet-700"
            defaultOpen={true}
            subtitle={`Flagged by the scan but not established — a developer still needs to confirm or refute each item. Report generated ${new Date(report.generatedAt).toLocaleDateString()}.`}
            renderDetail={(item) => (
              <>
                <p className="text-[13px] text-slate-600 leading-relaxed">
                  {item.businessImplication}
                </p>
                {item.verification && (
                  <dl className="space-y-2 text-[13px] leading-relaxed">
                    <div>
                      <dt className="font-semibold text-slate-700">What we saw</dt>
                      <dd className="text-slate-600">{item.verification.whatWeSaw}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-slate-700">If real</dt>
                      <dd className="text-slate-600">{item.verification.ifReal}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-slate-700">How a developer checks it</dt>
                      <dd className="text-slate-600">{item.verification.howToCheck}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-slate-700">What each answer means</dt>
                      <dd className="text-slate-600">{item.verification.whatEachAnswerMeans}</dd>
                    </div>
                  </dl>
                )}
              </>
            )}
          />

          {/* What the review could not establish — always shown */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-amber-700 mb-2">
              What this review could not establish
            </p>
            <ul className="list-disc ml-5 space-y-1">
              {report.couldNotEstablish.map((c, i) => (
                <li key={i} className="text-[13px] text-amber-900 leading-relaxed">
                  {c}
                </li>
              ))}
            </ul>
          </div>

          {/* Q&A — never printed: the Q&A stays live-only. */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 print:hidden">
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1 flex items-center gap-1.5">
              <MessageCircle className="w-4 h-4" /> Ask about this review
            </p>
            <p className="text-xs text-slate-500 mb-3">
              Answers come from the review above — never invented. Cost and time
              estimates are never given, by design.
            </p>
            <div className="flex flex-wrap gap-2 mb-3">
              {STARTER_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => {
                    setQuestion(q);
                    askQuestion(q);
                  }}
                  disabled={qaPhase === "loading"}
                  className="text-xs px-3 py-1.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") askQuestion(question);
                }}
                placeholder="Ask in plain English…"
                className="flex-1 text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {recognitionSupported ? (
                <button
                  type="button"
                  onClick={startListening}
                  aria-label="Ask by voice"
                  title="Ask by voice"
                  className={`p-2 rounded-lg border ${
                    listening
                      ? "bg-rose-100 border-rose-300 text-rose-600 animate-pulse"
                      : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <Mic className="w-5 h-5" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => askQuestion(question)}
                disabled={qaPhase === "loading" || !question.trim()}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {qaPhase === "loading" ? "Thinking…" : "Ask"}
              </button>
            </div>
            {qaPhase === "error" && (
              <p className="mt-3 text-[13px] text-rose-600">{qaError}</p>
            )}
            {qaPhase === "done" && qaAnswer && (
              <div className="mt-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[14px] text-slate-800 leading-relaxed flex-1">
                    {qaDeclined && (
                      <span className="font-semibold">Not covered by this review — </span>
                    )}
                    {qaAnswer}
                  </p>
                  <button
                    type="button"
                    onClick={toggleSpeak}
                    aria-label={speaking ? "Stop reading aloud" : "Read answer aloud"}
                    className="p-2 rounded-lg text-indigo-600 hover:bg-indigo-50 shrink-0"
                  >
                    {speaking ? (
                      <Square className="w-4 h-4" />
                    ) : (
                      <Volume2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Handoff */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1 flex items-center gap-1.5">
              <FileText className="w-4 h-4" /> Developer handoff
            </p>
            <p className="text-xs text-slate-500 mb-3">
              Select the items to hand to a developer. Exports as a free
              Markdown packet — no code is changed.
            </p>
            {handoffItems.length === 0 && (
              <p className="text-xs text-slate-500">
                Nothing to hand off — this review found no liabilities or
                half-built items.
              </p>
            )}
            <div className="space-y-1.5 mb-3">
              {handoffItems.map((item) => {
                const key = itemKey(item);
                return (
                  <label
                    key={key}
                    className={`flex items-start gap-2 text-[13px] text-slate-700 cursor-pointer ${checked.has(key) ? "" : "print:hidden"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(key)}
                      onChange={() => toggleChecked(key)}
                      className="mt-1 accent-indigo-600"
                    />
                    <span>
                      {item.title}
                      <span className="text-slate-400 font-mono text-xs">
                        {" "}
                        {item.file}
                        {item.line != null ? `:${item.line}` : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <button
              type="button"
              onClick={exportHandoff}
              disabled={checked.size === 0}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50 print:hidden"
            >
              <Download className="w-4 h-4" />
              Export handoff packet ({checked.size} of {handoffItems.length})
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
