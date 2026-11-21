// FinalRead buyer greeting: the buyer front door on getfinalread.com
// (two-sided flow §3 step 1). One code input + submit, and a "start a
// new review request" path. No workspace, no builder, no upload — the
// entry's direct-upload flow is RETIRED (a `finalread: true` scan now
// 400s server-side). The buyer enters the code the seller was given;
// the report opens only from a stored paid report (gate spec §5), never
// from a scan. Light theme: this screen only ever renders on the
// FinalRead host.
import React, { useEffect, useState } from "react";
import {
  Loader2,
  FileSearch,
  MessagesSquare,
  FileDown,
  Copy,
  Check,
  KeyRound,
  Plus,
} from "lucide-react";
import {
  apiFetch,
  fetchMe,
  AuthRequiredError,
  CreditsRequiredError,
} from "../../utils/apiFetch";
import FinalReadOverlay from "./FinalReadOverlay";
import FinalReadWaiting from "./FinalReadWaiting";

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

export default function FinalReadEntry() {
  // Buyer-facing tab title while the greeting is open; the server also
  // injects the FinalRead title per host, so this only re-asserts it.
  useEffect(() => {
    const prev = document.title;
    document.title = "FinalRead — Know where to look before you pay";
    return () => {
      document.title = prev;
    };
  }, []);

  // Everything the buyer does here is FinalRead: every credit gate in
  // this flow offers the FinalRead price list instead of consumer packs.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("codedoc:finalread-mode", { detail: { open: true } })
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent("codedoc:finalread-mode", { detail: { open: false } })
      );
    };
  }, []);

  // ---- Code entry (§3 step 1) ----
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState("");

  // ---- New review request (§3 step 2) ----
  const [dealTitle, setDealTitle] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [createdTitle, setCreatedTitle] = useState("");
  const [copied, setCopied] = useState(false);

  // ---- Gate (gate spec §5): the overlay renders ONLY from a stored
  // paid report. Paid → the stored report; unpaid → the payment prompt.
  type GateState = "idle" | "loading" | "paid" | "waiting" | "payment" | "generating";
  const [gate, setGate] = useState<GateState>("idle");
  const [paidReport, setPaidReport] = useState<{ report: any; reportId: string } | null>(null);
  const [gateMessage, setGateMessage] = useState("");
  const [gateReviewId, setGateReviewId] = useState<string | null>(null);
  const [gateProjectTitle, setGateProjectTitle] = useState("");
  const [validatedCode, setValidatedCode] = useState("");

  const resolveGate = async (reviewId: string | undefined, sellerPath: boolean) => {
    // No review id: no paid report can exist — the seller waits; a
    // buyer is prompted to pay.
    if (!reviewId) {
      setGate(sellerPath ? "waiting" : "payment");
      return;
    }
    setGateReviewId(reviewId);
    setGate("loading");
    try {
      const res = await fetch(
        `/api/finalread/reviews/${encodeURIComponent(reviewId)}/report`,
        { credentials: "include" }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPaidReport({ report: data.report, reportId: data.reportId });
        setGate("paid");
      } else if (res.status === 202) {
        setGateMessage(
          typeof data.message === "string" && data.message
            ? data.message
            : "The report is being generated. Please check back shortly."
        );
        setGate("generating");
      } else {
        // 403/404 (no paid report) and any other failure close the gate:
        // never render the report on an error.
        setGate(sellerPath ? "waiting" : "payment");
      }
    } catch {
      setGate(sellerPath ? "waiting" : "payment");
    }
  };

  // Open the $199 checkout through the existing pricing modal (the same
  // path the credits gate uses): the entry is in FinalRead mode, so the
  // modal lists the FinalRead pack. The validated code rides in the
  // event detail so the checkout carries it — without the code the
  // webhook would see a bare purchase and activate nothing.
  const openPayment = async () => {
    const me = await fetchMe().catch(() => null);
    window.dispatchEvent(
      new CustomEvent("codedoc:credits-required", {
        detail: {
          balance: me?.credits ?? 0,
          required: 400,
          inviteCode: validatedCode || undefined,
          projectTitle: gateProjectTitle || undefined,
        },
      })
    );
  };

  // Sign-in happens at submit, not before the buyer types (spec §3 step
  // 2): the buyer fills the form first; only the submit asks them to
  // sign in. After signing in they tap the same button again.
  const ensureSignedIn = async (): Promise<boolean> => {
    const me = await fetchMe().catch(() => null);
    if (me) return true;
    window.dispatchEvent(new CustomEvent("codedoc:auth-required"));
    return false;
  };

  const submitCode = async () => {
    const entered = code.trim().toUpperCase();
    if (!entered || codeBusy) return;
    setCodeError("");
    setCodeBusy(true);
    try {
      if (!(await ensureSignedIn())) {
        setCodeError("Sign in first — then tap Enter code again.");
        return;
      }
      const res = await apiFetch("/api/finalread/invite-codes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: entered }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "That code couldn't be checked. Try again.");
      if (!data.valid) {
        // Generic on purpose — no enumeration of whether the code exists,
        // is expired, is already used, or has no scan yet.
        setCodeError(
          "That code isn't valid. Check it with the seller — the code they were given is the one that opens this review."
        );
        return;
      }
      setValidatedCode(entered);
      setGateProjectTitle(typeof data.projectTitle === "string" ? data.projectTitle : "");
      if (data.activatedForCaller) {
        // Already paid: open the stored report, don't pay again.
        await resolveGate(
          typeof data.reviewId === "string" ? data.reviewId : undefined,
          false
        );
      } else {
        // Bound to a project with a pending audit: show the title, then
        // the $199 payment prompt.
        setGateReviewId(typeof data.reviewId === "string" ? data.reviewId : null);
        setGate("payment");
      }
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        setCodeError("Sign in first — then tap Enter code again.");
      } else if (e instanceof CreditsRequiredError) {
        setCodeError("Your credits need topping up before this review can open.");
      } else {
        setCodeError(e.message || "That code couldn't be checked. Try again.");
      }
    } finally {
      setCodeBusy(false);
    }
  };

  const submitRequest = async () => {
    const title = dealTitle.trim();
    if (!title || requestBusy) return;
    setRequestError("");
    setRequestBusy(true);
    try {
      if (!(await ensureSignedIn())) {
        setRequestError("Sign in first — then tap Create request again.");
        return;
      }
      const res = await apiFetch("/api/finalread/review-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The request couldn't be created. Try again.");
      // The code is shown ONCE — only the hash is stored, so a lost code
      // cannot be recovered; the buyer creates a new request instead.
      setCreatedCode(typeof data.code === "string" ? data.code : null);
      setCreatedTitle(title);
      setDealTitle("");
      setCopied(false);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) {
        setRequestError("Sign in first — then tap Create request again.");
      } else {
        setRequestError(e.message || "The request couldn't be created. Try again.");
      }
    } finally {
      setRequestBusy(false);
    }
  };

  const copyCode = async () => {
    if (!createdCode) return;
    try {
      await navigator.clipboard.writeText(createdCode);
      setCopied(true);
    } catch {
      setCodeError("Copy didn't work — long-press the code to copy it.");
    }
  };

  const resetToGreeting = () => {
    setGate("idle");
    setPaidReport(null);
    setGateReviewId(null);
    setGateMessage("");
    setGateProjectTitle("");
    setValidatedCode("");
    setCode("");
    setCodeError("");
  };

  // The gate surface (gate spec §5): what the greeting shows after a
  // code validates, instead of the stakeholder view from a raw audit.
  // Paid → the stored report, same overlay as before. Unpaid → the
  // payment prompt with the project title shown before paying (§11).
  const renderGate = (onClose: () => void) => {
    if (gate === "paid" && paidReport) {
      return (
        <FinalReadOverlay
          report={paidReport.report}
          reportId={paidReport.reportId}
          onClose={onClose}
        />
      );
    }
    if (gate === "waiting") {
      return <FinalReadWaiting onClose={onClose} />;
    }
    if (gate === "generating") {
      return <FinalReadWaiting message={gateMessage} onClose={onClose} />;
    }
    if (gate === "payment") {
      return (
        <div className="flex-1 overflow-y-auto bg-white">
          <div className="max-w-3xl mx-auto px-4 py-8 md:py-12 select-text">
            <div className="bg-white border border-indigo-200 rounded-2xl p-8 md:p-10 text-center space-y-4 shadow-sm">
              <h2 className="text-xl font-extrabold tracking-tight text-slate-900">
                Your review is ready
              </h2>
              {gateProjectTitle && (
                <p className="text-sm font-semibold text-slate-700">
                  Review: <span className="break-words">{gateProjectTitle}</span>
                </p>
              )}
              <p className="text-sm text-slate-600 leading-relaxed max-w-md mx-auto">
                The scan finished. The full report — plain-English findings,
                the verdict, and stakeholder Q&amp;A — opens once the $199
                review is paid for.
              </p>
              <p className="text-xs text-indigo-700">
                <span className="font-bold text-sm text-indigo-900">$199</span>
                {"  "}· one complete review · includes 2 re-scans after fixes
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void openPayment()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Buy the $199 review
                </button>
                <button
                  type="button"
                  onClick={() => void resolveGate(gateReviewId ?? undefined, false)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl border border-slate-300 transition"
                >
                  I&apos;ve paid — open my report
                </button>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-xs text-slate-500 hover:text-slate-800 transition"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      );
    }
    // Loading: the gate is resolving — honest progress.
    return (
      <div className="flex-1 overflow-y-auto bg-white">
        <div className="max-w-3xl mx-auto px-4 py-8 md:py-12 text-center">
          <Loader2 className="w-10 h-10 animate-spin text-indigo-600 mx-auto mb-4" />
          <p className="text-sm font-semibold text-slate-800">
            Checking your report…
          </p>
        </div>
      </div>
    );
  };

  // A validated code resolves the gate instead of opening the stakeholder
  // view from a raw audit (gate spec §5). Closing returns to this
  // greeting for another code.
  if (gate !== "idle") {
    return renderGate(resetToGreeting);
  }

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <div className="max-w-3xl mx-auto px-4 py-8 md:py-12 select-text">
        {/* Top bar: no Back button on the FinalRead host (front-door §2) —
            the way back to the workspace is the link, not a back step. */}
        <div className="flex items-center justify-between mb-8">
          <a
            href="https://gradevibes.com"
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition"
          >
            Developer workspace — gradevibes.com
          </a>
          <span className="text-[11px] font-bold uppercase tracking-widest text-indigo-600">
            FinalRead
          </span>
        </div>

        {/* Hero — kept verbatim (front-door spec §2). */}
        <div className="text-center mb-8">
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900 leading-snug">
            Know where to look{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-violet-500">
              before you pay
            </span>{" "}
            for a deeper code review.
          </h1>
          <p className="text-slate-600 text-sm max-w-xl mx-auto mt-3 leading-relaxed">
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
                className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm"
              >
                <div className="p-2 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 w-fit mb-2.5">
                  <Icon className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-bold text-slate-900">{d.title}</h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  {d.desc}
                </p>
              </div>
            );
          })}
        </div>

        {/* Pricing strip */}
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 mb-8 flex items-center justify-center gap-2 text-center">
          <p className="text-xs text-indigo-800">
            <span className="font-bold text-sm text-indigo-900">$199</span>
            {"  "}· one complete review · includes 2 re-scans after fixes
          </p>
        </div>

        {/* Code entry (§3 step 1): one code input + submit. */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 shadow-sm space-y-4 mb-6">
          <h2 className="text-sm font-bold text-slate-900 text-center">
            Have a review code? Enter it
          </h2>
          <p className="text-xs text-slate-600 text-center leading-relaxed">
            The seller sends you the code for your deal. Enter it here and
            the review opens once the $199 is paid.
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1 min-w-0">
              <KeyRound className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCode();
                }}
                placeholder="8-character code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                disabled={codeBusy}
                className="w-full bg-white border border-slate-300 rounded-xl pl-9 pr-3 py-2.5 text-sm font-mono tracking-[0.2em] text-slate-900 placeholder:text-slate-400 placeholder:tracking-normal focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
            </div>
            <button
              type="button"
              onClick={() => void submitCode()}
              disabled={codeBusy || !code.trim()}
              className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {codeBusy ? "Checking…" : "Enter code"}
            </button>
          </div>
          {codeError && (
            <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {codeError}
            </p>
          )}
        </div>

        {/* New review request (§3 step 2): name the deal, get the code once. */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-bold text-slate-900 text-center">
            Starting a new deal? Create a review request
          </h2>
          {createdCode ? (
            <div className="space-y-3 text-center">
              <p className="text-xs text-slate-600 leading-relaxed">
                Send this code to the seller for{" "}
                <span className="font-semibold text-slate-900 break-words">{createdTitle}</span>.
                They save the project against it — then you enter the same
                code above to pay and open the report.
              </p>
              <div className="flex items-center justify-center gap-2">
                <code className="text-xl font-mono font-bold tracking-[0.3em] text-slate-900 bg-slate-100 border border-slate-300 rounded-xl px-4 py-2.5 break-all">
                  {createdCode}
                </code>
                <button
                  type="button"
                  onClick={() => void copyCode()}
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl border border-slate-300 transition"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                This code is shown once — save it now. If you lose it, create
                a new request.
              </p>
              <button
                type="button"
                onClick={() => { setCreatedCode(null); setCreatedTitle(""); setCopied(false); }}
                className="text-xs text-slate-500 hover:text-slate-800 transition"
              >
                Create another request
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-600 text-center leading-relaxed">
                Name the deal and you&apos;ll get a code to send the seller.
                You can hold up to 3 open requests at a time.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={dealTitle}
                  onChange={(e) => setDealTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitRequest();
                  }}
                  placeholder="e.g. Acme CRM — $24,000 deal"
                  disabled={requestBusy}
                  className="flex-1 min-w-0 bg-white border border-slate-300 rounded-xl px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => void submitRequest()}
                  disabled={requestBusy || !dealTitle.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Plus className="w-3.5 h-3.5" /> Create request
                </button>
              </div>
              {requestError && (
                <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                  {requestError}
                </p>
              )}
            </>
          )}
        </div>

        <p className="text-[11px] text-slate-500 text-center leading-relaxed pt-6">
          FinalRead doesn&apos;t replace engineering due diligence. It tells you
          where to point it — so the deep review starts with what matters.
        </p>
      </div>
    </div>
  );
}
