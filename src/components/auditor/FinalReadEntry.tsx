// FinalRead standalone entry: the buyer-facing front door to a diligence
// review. Reuses the GradeVibes engine end to end (upload-zip / import-repo /
// project-intelligence); the buyer never sees the GradeVibes workspace UI.
// Plain-English surface: no file paths, line numbers, or code jargon here.
import React, { useEffect, useRef, useState } from "react";
import {
  Upload,
  Link2,
  Loader2,
  ArrowLeft,
  FileSearch,
  MessagesSquare,
  FileDown,
  AlertCircle,
  RotateCcw,
} from "lucide-react";
import {
  apiFetch,
  fetchMe,
  AuthRequiredError,
  CreditsRequiredError,
} from "../../utils/apiFetch";
import FinalReadOverlay, {
  intelResultToFinalReadInput,
} from "./FinalReadOverlay";
import {
  createEntryReview,
  reviewHasReport,
  showDeveloperWorkspaceToggle,
  titleFromRepoUrl,
  titleFromZipName,
  withIntelResult,
  type SharedReview,
  type SharedReviewSource,
} from "../../utils/sharedReview";

type Phase = "idle" | "uploading" | "scanning" | "done" | "error";

// Rotating status lines while the single scan request is in flight.
// They describe the one ongoing review — never fake percentages.
const SCAN_STAGES = [
  "Reading every file in the codebase…",
  "Mapping how the pieces connect…",
  "Checking what's finished and what's half-built…",
  "Weighing the risks that matter most to a buyer…",
  "Writing your plain-English report…",
];

const DELIVERABLES = [
  {
    icon: FileSearch,
    title: "The full report",
    desc: "A standardized first-pass assessment: material risks, incomplete functionality, and open questions — every claim tied to evidence.",
  },
  {
    icon: MessagesSquare,
    title: "Stakeholder Q&A",
    desc: "Ask anything in plain English and get answers grounded in the review. Ask it technically and you'll get the technical detail.",
  },
  {
    icon: FileDown,
    title: "Developer handoff",
    desc: "A ready-to-send packet so a developer starts with the consequential findings instead of spending days discovering basics.",
  },
];

export default function FinalReadEntry({
  onExit,
  sharedReview = null,
  onSharedReviewChange,
}: {
  onExit: () => void;
  // The shared review held in App. When it exists, the entry adopts it
  // instead of asking for another upload — toggling never re-scans or
  // re-charges. An entry-originated review is recorded here too (so
  // re-entering restores the report), but it never sets App workspace state.
  sharedReview?: SharedReview | null;
  onSharedReviewChange?: (next: SharedReview | null) => void;
}) {
  // Buyer-facing tab title while the FinalRead entry is open; restore on exit.
  useEffect(() => {
    const prev = document.title;
    document.title = "FinalRead — Know where to look before you pay";
    return () => {
      document.title = prev;
    };
  }, []);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stageIdx, setStageIdx] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadLabel, setUploadLabel] = useState("");
  const [projectTitle, setProjectTitle] = useState("Your codebase");
  const [intelResult, setIntelResult] = useState<any>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Adopted mode is decided at mount: the entry opened onto a review that
  // already exists in the shared state. It is never re-derived while
  // mounted, so closing a just-finished ingest report returns to the
  // ingest hero instead of re-showing the adopted report.
  const [adoptedAtMount] = useState(() => reviewHasReport(sharedReview));
  const [continueAtMount] = useState(
    () => sharedReview != null && !reviewHasReport(sharedReview)
  );

  // Everything the buyer does here is FinalRead: every credit gate in this
  // flow offers the FinalRead price list instead of consumer packs.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("codedoc:finalread-mode", { detail: { open: true } })
    );
    void fetchMe().then((u) => setBalance(u ? u.credits : null));
    return () => {
      window.dispatchEvent(
        new CustomEvent("codedoc:finalread-mode", { detail: { open: false } })
      );
    };
  }, []);

  // Advance the honest status lines while a scan is running.
  useEffect(() => {
    if (phase === "scanning") {
      setStageIdx(0);
      stageTimer.current = setInterval(
        () => setStageIdx((i) => Math.min(i + 1, SCAN_STAGES.length - 1)),
        9000
      );
    }
    return () => {
      if (stageTimer.current) {
        clearInterval(stageTimer.current);
        stageTimer.current = null;
      }
    };
  }, [phase]);

  const fail = (message: string) => {
    setError(message);
    setPhase("error");
    setBusy(false);
  };

  // Sign-in is required before a scan can start. Reuses the existing auth
  // modal; apiFetch's 401 handling is the backstop for the calls below.
  const ensureSignedIn = async (): Promise<boolean> => {
    const me = await fetchMe().catch(() => null);
    if (me) {
      setBalance(me.credits);
      return true;
    }
    window.dispatchEvent(new CustomEvent("codedoc:auth-required"));
    return false;
  };

  const runReview = async (title: string, origin: SharedReviewSource | "preserve") => {
    setProjectTitle(title);
    setPhase("scanning");
    setError("");
    setNotice("");
    try {
      const response = await apiFetch("/api/project-intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error(
          "The review service returned an unexpected response. It may be restarting — please try again in a moment."
        );
      }
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(
          errData.error || "The review couldn't be completed. Please try again."
        );
      }
      const parsed = await response.json();
      setIntelResult(parsed);
      // The finished scan becomes the shared review: re-entering the entry
      // restores the report without re-uploading or re-scanning. A scan run
      // on an existing review ("preserve") keeps its origin — a workspace
      // review stays workspace-originated, so the toggle stays available.
      const next =
        origin === "preserve" && sharedReview
          ? withIntelResult(sharedReview, parsed)
          : createEntryReview(title, parsed);
      onSharedReviewChange?.(next);
      setPhase("done");
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        setPhase("idle");
      } else if (e instanceof CreditsRequiredError) {
        setPhase("idle");
        setNotice(
          "Your review is ready to start as soon as your credits land — the checkout window above has everything you need."
        );
        void fetchMe().then((u) => setBalance(u ? u.credits : null));
      } else {
        fail(
          e.message ||
            "Something went wrong while reviewing the codebase. Please try again."
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const uploadZipFile = (file: File) => {
    if (!file || busy) return;
    if (!file.name.endsWith(".zip")) {
      fail("That file isn't a .zip archive. Please choose a .zip of the codebase.");
      return;
    }
    void (async () => {
      if (!(await ensureSignedIn())) return;
      setBusy(true);
      setError("");
      setNotice("");
      setUploadLabel("Uploading your codebase…");
      setPhase("uploading");
      try {
        const base64String = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsDataURL(file);
          reader.onload = () =>
            resolve((reader.result as string).split(",")[1] ?? "");
          reader.onerror = () => reject(new Error("Couldn't read that file."));
        });
        const response = await apiFetch("/api/upload-zip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zipBase64: base64String }),
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(
            errData.error || "The archive couldn't be opened. Please check it's a valid .zip."
          );
        }
        const title = titleFromZipName(file.name);
        await runReview(title, "entry");
      } catch (e: any) {
        if (e instanceof AuthRequiredError || e instanceof CreditsRequiredError) {
          setPhase("idle");
          setBusy(false);
          if (e instanceof CreditsRequiredError) {
            setNotice(
              "Your review is ready to start as soon as your credits land — the checkout window above has everything you need."
            );
          }
        } else {
          fail(e.message || "The upload didn't go through. Please try again.");
        }
      }
    })();
  };

  const importRepo = () => {
    const url = repoUrl.trim();
    if (!url || busy) return;
    void (async () => {
      if (!(await ensureSignedIn())) return;
      setBusy(true);
      setError("");
      setNotice("");
      setUploadLabel("Fetching the repository…");
      setPhase("uploading");
      try {
        const response = await apiFetch("/api/import-repo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl: url }),
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(
            errData.error || "That repository couldn't be fetched. Please check the URL."
          );
        }
        const title = titleFromRepoUrl(url);
        setRepoUrl("");
        await runReview(title, "entry");
      } catch (e: any) {
        if (e instanceof AuthRequiredError || e instanceof CreditsRequiredError) {
          setPhase("idle");
          setBusy(false);
          if (e instanceof CreditsRequiredError) {
            setNotice(
              "Your review is ready to start as soon as your credits land — the checkout window above has everything you need."
            );
          }
        } else {
          fail(e.message || "That repository couldn't be fetched. Please check the URL.");
        }
      }
    })();
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      uploadZipFile(e.dataTransfer.files[0]);
    }
  };

  const resetToEntry = () => {
    setPhase("idle");
    setIntelResult(null);
    setError("");
    setNotice("");
    void fetchMe().then((u) => setBalance(u ? u.credits : null));
  };

  // The completed stakeholder view takes over the screen, as it does in the
  // main app. Closing it returns to this entry screen for another review.
  if (phase === "done" && intelResult) {
    return (
      <FinalReadOverlay
        audit={intelResultToFinalReadInput(intelResult, projectTitle)}
        onClose={resetToEntry}
      />
    );
  }

  // Adopted mode: the entry opened onto a finished shared review, so the
  // report renders immediately — no upload, no second scan, no new charge.
  // Closing it returns to the workspace (the review came from there), not
  // to this entry's upload hero.
  if (adoptedAtMount && sharedReview?.intelResult) {
    return (
      <FinalReadOverlay
        audit={intelResultToFinalReadInput(sharedReview.intelResult, sharedReview.title)}
        onClose={onExit}
      />
    );
  }

  const working = phase === "uploading" || phase === "scanning";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-8 md:py-12 select-text">
        {/* Top bar */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onExit}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            {/* Visible only for workspace-originated reviews: a buyer who
                only ever used the entry has no workspace and sees no toggle. */}
            {showDeveloperWorkspaceToggle(sharedReview) && (
              <button
                type="button"
                onClick={onExit}
                className="flex items-center gap-1.5 text-xs font-medium text-indigo-300 bg-indigo-500/10 border border-indigo-500/25 hover:bg-indigo-500/20 rounded-lg px-2.5 py-1.5 transition"
              >
                Developer workspace
              </button>
            )}
          </div>
          <span className="text-[11px] font-bold uppercase tracking-widest text-indigo-400">
            FinalRead
          </span>
        </div>

        {/* Hero */}
        <div className="text-center mb-8">
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-100 leading-snug">
            Know where to look{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-violet-300">
              before you pay
            </span>{" "}
            for a deeper code review.
          </h1>
          <p className="text-slate-400 text-sm max-w-xl mx-auto mt-3 leading-relaxed">
            FinalRead is an independent, standardized first pass over a
            software codebase. It finds the material risks, the unfinished
            work, and the questions a buyer should ask — before you commit to
            full engineering due diligence.
          </p>
        </div>

        {/* Deliverables */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {DELIVERABLES.map((d) => {
            const Icon = d.icon;
            return (
              <div
                key={d.title}
                className="bg-slate-900 border border-slate-800 rounded-xl p-4"
              >
                <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 w-fit mb-2.5">
                  <Icon className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-bold text-slate-200">{d.title}</h3>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  {d.desc}
                </p>
              </div>
            );
          })}
        </div>

        {/* Pricing strip */}
        <div className="bg-indigo-500/10 border border-indigo-500/25 rounded-xl px-4 py-3 mb-8 flex items-center justify-center gap-2 text-center">
          <p className="text-xs text-indigo-200">
            <span className="font-bold text-sm text-indigo-100">$199</span>
            {"  "}· one complete review · 400 credits, and the review is the
            only thing they can be spent on here
          </p>
        </div>

        {/* Continue: a shared review exists but has no finished report yet
            (uploaded in the workspace, or a scan still running / failed).
            Offer to run or resume it — never ask for a second upload. */}
        {continueAtMount && phase === "idle" && sharedReview && (
          <div className="bg-slate-900 border border-indigo-500/25 rounded-2xl p-5 md:p-6 shadow-xl space-y-3 mb-8">
            <h2 className="text-sm font-bold text-slate-200">
              Your review of {sharedReview.title} is already here
            </h2>
            {sharedReview.intelResult ? (
              <>
                <p className="text-xs text-slate-400 leading-relaxed">
                  The report is ready — no need to upload the codebase again.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setProjectTitle(sharedReview.title);
                    setIntelResult(sharedReview.intelResult);
                    setPhase("done");
                  }}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-bold rounded-xl transition"
                >
                  View your report
                </button>
              </>
            ) : sharedReview.intelStatus === "loading" ? (
              <p className="text-xs text-slate-400 leading-relaxed">
                The review is still running in the workspace — your report
                will appear here when it's ready. Re-open this page to see it.
              </p>
            ) : (
              <>
                <p className="text-xs text-slate-400 leading-relaxed">
                  It was uploaded in the developer workspace, so there's no
                  need to upload it again. Run the review once and it will be
                  shared with both views.
                </p>
                {sharedReview.intelError && (
                  <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                    The last scan didn't finish: {sharedReview.intelError}
                  </p>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runReview(sharedReview.title, "preserve")}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-bold rounded-xl transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Run the review
                </button>
              </>
            )}
          </div>
        )}

        {working ? (
          /* Honest progress: one scan in flight, staged status lines */
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 md:p-10 text-center">
            <Loader2 className="w-10 h-10 animate-spin text-indigo-400 mx-auto mb-4" />
            <p className="text-sm font-semibold text-slate-200">
              {phase === "uploading" ? uploadLabel : "Reviewing your codebase…"}
            </p>
            {phase === "scanning" && (
              <p
                key={stageIdx}
                className="text-xs text-slate-400 mt-2 animate-pulse"
              >
                {SCAN_STAGES[stageIdx]}
              </p>
            )}
            <p className="text-[11px] text-slate-500 mt-4 max-w-md mx-auto leading-relaxed">
              A thorough review takes a few minutes. You can leave this page
              open — your report appears here when it's ready.
            </p>
          </div>
        ) : phase === "error" ? (
          <div className="bg-slate-900 border border-rose-500/25 rounded-2xl p-8 text-center">
            <AlertCircle className="w-10 h-10 text-rose-400 mx-auto mb-4" />
            <p className="text-sm font-semibold text-slate-200 mb-2">
              The review couldn't start
            </p>
            <p className="text-xs text-slate-400 mb-6 max-w-md mx-auto leading-relaxed">
              {error}
            </p>
            <button
              type="button"
              onClick={resetToEntry}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-bold rounded-xl transition"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        ) : (
          /* Ingest */
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 md:p-6 shadow-xl space-y-4">
            <h2 className="text-sm font-bold text-slate-200 text-center">
              Get your codebase reviewed
            </h2>

            {balance !== null && (
              <p className="text-[11px] text-slate-500 text-center -mt-2">
                Your balance:{" "}
                <span className="text-slate-300 font-semibold">
                  {balance.toLocaleString()} credits
                </span>
              </p>
            )}

            {notice && (
              <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                {notice}
              </p>
            )}

            <div
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-2xl p-8 text-center transition duration-150 ${
                dragActive
                  ? "border-indigo-500 bg-indigo-500/10 text-indigo-300"
                  : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700 hover:bg-slate-950/60"
              }`}
            >
              <label className="flex flex-col items-center justify-center cursor-pointer py-4 space-y-4">
                <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-slate-400">
                  <Upload className="w-8 h-8" />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-slate-300">
                    Drop your project{" "}
                    <span className="text-indigo-400 font-mono">.zip</span> here
                  </p>
                  <p className="text-[10px] text-slate-500">
                    or click to choose a file from your device
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      uploadZipFile(e.target.files[0]);
                      e.target.value = "";
                    }
                  }}
                  className="hidden"
                />
              </label>
            </div>

            <div className="flex items-center gap-2 px-1">
              <div className="h-px flex-1 bg-slate-800/60" />
              <span className="text-[9px] uppercase tracking-widest text-slate-500 font-mono">
                or
              </span>
              <div className="h-px flex-1 bg-slate-800/60" />
            </div>

            <div className="flex gap-2">
              <div className="relative flex-1 min-w-0">
                <Link2 className="w-3.5 h-3.5 text-slate-600 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") importRepo();
                  }}
                  placeholder="Paste a GitHub repo URL — https://github.com/owner/repo"
                  spellCheck={false}
                  disabled={busy}
                  className="w-full bg-slate-950/80 border border-slate-800 rounded-xl pl-9 pr-3 py-2.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/60 disabled:opacity-50"
                />
              </div>
              <button
                type="button"
                onClick={importRepo}
                disabled={busy || !repoUrl.trim()}
                className="px-4 py-2.5 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 hover:text-indigo-200 border border-indigo-500/25 rounded-xl text-[10px] font-bold uppercase tracking-wider transition whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Start review
              </button>
            </div>
            <p className="text-[9px] text-slate-600 font-mono text-center -mt-1">
              Public repositories only — fetched straight from GitHub, nothing
              to upload.
            </p>

            <p className="text-[11px] text-slate-500 text-center leading-relaxed pt-1">
              FinalRead doesn't replace engineering due diligence. It tells you
              where to point it — so the deep review starts with what matters.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
