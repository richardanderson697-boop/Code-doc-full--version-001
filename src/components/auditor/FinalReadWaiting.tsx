// FinalRead "waiting on buyer" state (stakeholder-view gate spec §3):
// what the seller sees on a FinalRead path before the buyer's payment.
// Plain copy, Richard's words: "waiting on buyer". Contains nothing of
// the report — no scores, no findings in stakeholder framing, no print,
// no export, no Q&A. Portaled like the overlay, so the seller's mental
// model is unchanged: they hit the FinalRead path, they get the waiting
// state; after payment the same path opens the report.
//
// The optional message covers the "generating" state (the payment has
// landed and the report is being built): the server's message is shown
// instead of the waiting copy.
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function FinalReadWaiting({
  message,
  onClose,
}: {
  message?: string;
  onClose: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-4">
      <div className="w-full max-w-3xl my-8 bg-slate-50 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-start justify-between px-6 py-5 bg-white border-b border-slate-200">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-indigo-600">
              FinalRead stakeholder view
            </p>
            <h2 className="text-xl font-bold text-slate-900 mt-1">
              {message ?? "waiting on buyer"}
            </h2>
            {!message && (
              <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                The report will open here once the buyer pays — nothing to do
                until then.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
