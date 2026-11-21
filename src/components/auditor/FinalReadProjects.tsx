// FinalRead seller projects: the seller's project workspace (two-sided
// flow §2 step 3). Save a project against the buyer's review-request
// code, run the initial scan FROM the saved project, watch the bound
// request, and — once the buyer pays — read the report and the Q&A log
// with the same access as the buyer. Dark theme: this is the workspace
// side. The buyer never sees this panel, and it never shows the buyer
// the project record.
import React, { useEffect, useState } from "react";
import {
  X,
  Loader2,
  Save,
  Play,
  RefreshCw,
  Eye,
  MessageSquare,
  AlertCircle,
  Check,
} from "lucide-react";
import {
  apiFetch,
  AuthRequiredError,
  CreditsRequiredError,
} from "../../utils/apiFetch";
import FinalReadOverlay from "./FinalReadOverlay";

interface ProjectSummary {
  id: string;
  title: string;
  status: string;
  finalreadReviewId: string | null;
  requestId: string | null;
  scanInProgressAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectDetail {
  project: ProjectSummary;
  review?: {
    id: string;
    purchaseStripeEventId: string | null;
    hasReport: boolean;
  };
  versions: { id: string; versionNumber: number; contentHash: string; createdAt: string }[];
  request?: {
    id: string;
    title: string;
    status: string;
    projectId: string | null;
    expiresAt: string;
    createdAt: string;
  } | null;
}

export default function FinalReadProjects({
  open,
  onClose,
  defaultTitle = "",
}: {
  open: boolean;
  onClose: () => void;
  defaultTitle?: string;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Save form
  const [saveTitle, setSaveTitle] = useState(defaultTitle);
  const [saveCode, setSaveCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Re-bind form (draft only)
  const [rebindCode, setRebindCode] = useState("");
  const [rebinding, setRebinding] = useState(false);

  // Scan
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    score: number | null;
    summary: string;
  } | null>(null);

  // Report overlay + Q&A log
  const [paidReport, setPaidReport] = useState<{ report: any; reportId: string } | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [qaTurns, setQaTurns] = useState<
    { question: string; answer: string; citedFindings: string[]; createdAt: string }[]
  >([]);

  useEffect(() => {
    if (open) {
      setSaveTitle(defaultTitle);
      void loadProjects();
    }
    // Mount/open only — the title is a starting value, not a live sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const loadProjects = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/finalread/projects");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't load your projects.");
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        setError("Sign in to see your FinalRead projects.");
      } else {
        setError(e.message || "Couldn't load your projects.");
      }
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setScanResult(null);
    setPaidReport(null);
    setQaTurns([]);
    try {
      const res = await apiFetch(`/api/finalread/projects/${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't load the project.");
      setDetail(data);
      if (data.review?.id) {
        try {
          const qaRes = await apiFetch(
            `/api/finalread/reviews/${encodeURIComponent(data.review.id)}/qa-log`
          );
          const qaData = await qaRes.json().catch(() => ({}));
          if (qaRes.ok && Array.isArray(qaData.turns)) setQaTurns(qaData.turns);
        } catch {
          // The Q&A log is a nice-to-have here; the project still loads.
        }
      }
    } catch (e: any) {
      setError(e.message || "Couldn't load the project.");
    } finally {
      setDetailLoading(false);
    }
  };

  const saveProject = async () => {
    const title = saveTitle.trim();
    const requestCode = saveCode.trim().toUpperCase();
    if (!title || !requestCode || saving) return;
    setSaveError("");
    setSaving(true);
    try {
      const res = await apiFetch("/api/finalread/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, requestCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't save the project.");
      setSaveCode("");
      setNotice(`Saved “${title}” — bound to the buyer's review request.`);
      await loadProjects();
      if (data.project?.id) await loadDetail(data.project.id);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        setSaveError("Sign in first — then save again.");
      } else {
        setSaveError(e.message || "Couldn't save the project.");
      }
    } finally {
      setSaving(false);
    }
  };

  const runScan = async () => {
    if (!selectedId || scanning) return;
    setScanning(true);
    setScanResult(null);
    setNotice("");
    try {
      const res = await apiFetch("/api/project-intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: selectedId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          setNotice("A scan is already running for this project. Wait for it to finish, then try again.");
          return;
        }
        throw new Error(data.error || "The scan couldn't run.");
      }
      if (data.codeUnchanged) {
        setNotice("The code hasn't changed since the last review — no re-scan needed. Your previous report still stands.");
        return;
      }
      const score =
        typeof data.completenessScore === "number" ? data.completenessScore : null;
      setScanResult({
        score,
        summary:
          typeof data.overallSummary === "string" && data.overallSummary
            ? data.overallSummary
            : "Scan complete.",
      });
      setNotice(
        "Scan complete. The full report opens once the buyer pays — until then you see the developer view in the workspace."
      );
      await loadDetail(selectedId);
      await loadProjects();
    } catch (e: any) {
      if (e instanceof CreditsRequiredError) {
        setNotice("The scan needs credits — the checkout window above has everything you need.");
      } else if (e instanceof AuthRequiredError) {
        setNotice("Sign in first — then run the scan again.");
      } else {
        setNotice(e.message || "The scan couldn't run.");
      }
    } finally {
      setScanning(false);
    }
  };

  const rebind = async () => {
    const requestCode = rebindCode.trim().toUpperCase();
    if (!selectedId || !requestCode || rebinding) return;
    setRebinding(true);
    try {
      const res = await apiFetch(`/api/finalread/projects/${encodeURIComponent(selectedId)}/re-bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't re-bind the project.");
      setRebindCode("");
      setNotice("Project re-bound to the new review request.");
      await loadDetail(selectedId);
      await loadProjects();
    } catch (e: any) {
      setNotice(e.message || "Couldn't re-bind the project.");
    } finally {
      setRebinding(false);
    }
  };

  const closeProject = async () => {
    if (!selectedId) return;
    try {
      const res = await apiFetch(
        `/api/finalread/projects/${encodeURIComponent(selectedId)}/close`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't close the project.");
      setSelectedId(null);
      setDetail(null);
      setNotice("Project closed. The paid report, Q&A history, and versions are kept.");
      await loadProjects();
    } catch (e: any) {
      setNotice(e.message || "Couldn't close the project.");
    }
  };

  const viewReport = async () => {
    if (!detail?.review?.id) return;
    setReportLoading(true);
    try {
      const res = await apiFetch(
        `/api/finalread/reviews/${encodeURIComponent(detail.review.id)}/report`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The report isn't available yet.");
      setPaidReport({ report: data.report, reportId: data.reportId });
    } catch (e: any) {
      setNotice(e.message || "The report isn't available yet.");
    } finally {
      setReportLoading(false);
    }
  };

  if (!open) return null;

  // The paid report opens in the same overlay the buyer sees.
  if (paidReport) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-950 overflow-y-auto">
        <FinalReadOverlay
          report={paidReport.report}
          reportId={paidReport.reportId}
          onClose={() => setPaidReport(null)}
        />
      </div>
    );
  }

  const requestStatusLabel = (status: string) => {
    switch (status) {
      case "requested":
        return "Requested — waiting for the seller to save the project";
      case "uploaded":
        return "Uploaded — project saved, waiting for the buyer's payment";
      case "reserved":
        return "Reserved — the buyer is checking out right now";
      case "activated":
        return "Paid — the report is open to buyer and seller";
      case "expired":
        return "Expired";
      case "revoked":
        return "Revoked";
      default:
        return status;
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-sm overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-8 select-text">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-extrabold tracking-tight text-slate-100">
            FinalRead projects
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {notice && (
          <p className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 mb-4 flex items-start gap-2">
            <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {notice}
          </p>
        )}
        {error && (
          <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2 mb-4 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
          </p>
        )}

        {/* Save this project (§2 step 3): title + the buyer's code. */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-6 space-y-3">
          <h3 className="text-sm font-bold text-slate-200">Save this project</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            The buyer creates a review request and sends you its code. Save
            the project against that code — then run the initial scan from
            the saved project. A save without a valid code is rejected.
          </p>
          <input
            type="text"
            value={saveTitle}
            onChange={(e) => setSaveTitle(e.target.value)}
            placeholder="Project title"
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/60"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={saveCode}
              onChange={(e) => setSaveCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveProject();
              }}
              placeholder="Buyer's 8-character code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-sm font-mono tracking-[0.2em] text-slate-200 placeholder:text-slate-600 placeholder:tracking-normal focus:outline-none focus:border-indigo-500/60"
            />
            <button
              type="button"
              onClick={() => void saveProject()}
              disabled={saving || !saveTitle.trim() || !saveCode.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-indigo-500 hover:bg-indigo-400 text-white rounded-xl text-xs font-bold transition whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Save className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Save project"}
            </button>
          </div>
          {saveError && (
            <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
              {saveError}
            </p>
          )}
        </div>

        {/* Projects list */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-6">
          <h3 className="text-sm font-bold text-slate-200 mb-3">Your projects</h3>
          {loading ? (
            <p className="text-xs text-slate-400 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </p>
          ) : projects.length === 0 ? (
            <p className="text-xs text-slate-500 leading-relaxed">
              No saved projects yet. Save one above with the buyer&apos;s code.
            </p>
          ) : (
            <ul className="space-y-2">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => void loadDetail(p.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border transition ${
                      selectedId === p.id
                        ? "border-indigo-500/50 bg-indigo-500/10"
                        : "border-slate-800 bg-slate-950 hover:border-slate-700"
                    }`}
                  >
                    <span className="block text-sm font-semibold text-slate-200 break-words">
                      {p.title}
                    </span>
                    <span className="block text-[11px] text-slate-500 mt-0.5">
                      {p.status}
                      {p.finalreadReviewId ? " · scanned" : " · not scanned yet"}
                      {p.scanInProgressAt ? " · scan running" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Per-project detail */}
        {detailLoading && (
          <p className="text-xs text-slate-400 flex items-center gap-2 mb-6">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading project…
          </p>
        )}
        {detail && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-200 break-words">
                {detail.project.title}
              </h3>
              <p className="text-[11px] text-slate-500 mt-1">
                Status: {detail.project.status}
                {detail.review ? ` · review ${detail.review.id.slice(0, 12)}…` : " · no review yet"}
              </p>
              {detail.request && (
                <p className="text-xs text-slate-400 mt-2">
                  Review request “<span className="text-slate-200 break-words">{detail.request.title}</span>” —{" "}
                  {requestStatusLabel(detail.request.status)}
                </p>
              )}
              {detail.versions.length > 0 && (
                <p className="text-xs text-slate-400 mt-1">
                  Versions:{" "}
                  {detail.versions.map((v) => `v${v.versionNumber}`).join(", ")}
                </p>
              )}
            </div>

            {/* Scan */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void runScan()}
                disabled={scanning || detail.project.status === "closed"}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-indigo-500 hover:bg-indigo-400 text-white rounded-xl text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {scanning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {scanning
                  ? "Scanning…"
                  : detail.review
                    ? "Re-scan from saved project"
                    : "Run initial scan (free)"}
              </button>
              {detail.review?.hasReport && (
                <button
                  type="button"
                  onClick={() => void viewReport()}
                  disabled={reportLoading}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-white/5 hover:bg-white/10 text-slate-200 rounded-xl border border-slate-700 text-xs font-bold transition disabled:opacity-40"
                >
                  <Eye className="w-3.5 h-3.5" /> {reportLoading ? "Loading…" : "View report"}
                </button>
              )}
              {!detail.review?.hasReport && detail.review && (
                <span className="text-xs text-slate-400">
                  Waiting on buyer — the report opens once they pay.
                </span>
              )}
            </div>
            {scanResult && (
              <div className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5">
                <p className="text-xs text-slate-300">
                  {scanResult.score !== null && (
                    <>
                      Completeness: <span className="font-bold">{scanResult.score}/100</span> ·{" "}
                    </>
                  )}
                  <span className="break-words">{scanResult.summary}</span>
                </p>
              </div>
            )}

            {/* Re-bind (draft only, before payment) */}
            {detail.project.status === "draft" && (
              <div className="border-t border-slate-800 pt-4 space-y-2">
                <p className="text-xs font-semibold text-slate-300">
                  Re-bind to a different review request
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={rebindCode}
                    onChange={(e) => setRebindCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                    placeholder="New 8-character code"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm font-mono tracking-[0.2em] text-slate-200 placeholder:text-slate-600 placeholder:tracking-normal focus:outline-none focus:border-indigo-500/60"
                  />
                  <button
                    type="button"
                    onClick={() => void rebind()}
                    disabled={rebinding || !rebindCode.trim()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 text-slate-200 rounded-xl border border-slate-700 text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Re-bind
                  </button>
                </div>
              </div>
            )}

            {/* Q&A log (seller sees the full log, §5.6 option (a)) */}
            {qaTurns.length > 0 && (
              <div className="border-t border-slate-800 pt-4 space-y-3">
                <p className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  <MessageSquare className="w-3.5 h-3.5" /> Q&amp;A log ({qaTurns.length})
                </p>
                {qaTurns.map((t, i) => (
                  <div key={i} className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 space-y-1">
                    <p className="text-xs font-semibold text-slate-200 break-words">Q: {t.question}</p>
                    <p className="text-xs text-slate-400 leading-relaxed break-words">A: {t.answer}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Close */}
            {detail.project.status !== "closed" && (
              <div className="border-t border-slate-800 pt-4">
                <button
                  type="button"
                  onClick={() => void closeProject()}
                  className="text-xs text-slate-500 hover:text-rose-300 transition"
                >
                  Close this project
                </button>
                <p className="text-[11px] text-slate-600 mt-1">
                  Closing keeps the paid report, Q&amp;A history, and versions.
                  It fails while a buyer is checking out.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
