// Banner shown only inside a Facebook/Instagram in-app browser, where
// audio is restricted. Offers a break-out to the full browser, where the
// app's voice features work. Dismissal is owned by the caller (session).
import { X } from "lucide-react";
import {
  isAndroidUa,
  externalBrowserUrl,
  type InAppBrowserApp,
} from "../utils/inAppBrowser";

export default function InAppBrowserBanner({
  app,
  onDismiss,
}: {
  app: InAppBrowserApp;
  onDismiss: () => void;
}) {
  const label = app === "instagram" ? "Instagram" : "Facebook";
  const android =
    typeof navigator !== "undefined" && isAndroidUa(navigator.userAgent);
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-200 text-xs">
      <p className="flex-1 leading-relaxed">
        You are viewing GradeVibes inside {label}, where audio is limited. For
        full voice features, open this page in your browser.{" "}
        {android ? (
          <a
            href={externalBrowserUrl()}
            className="font-semibold text-amber-100 underline underline-offset-2"
          >
            Open in browser
          </a>
        ) : (
          <span>
            Tap Share, then &ldquo;Open in Safari&rdquo;.
          </span>
        )}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="p-1 rounded-lg hover:bg-amber-500/20 text-amber-300 transition duration-150"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
