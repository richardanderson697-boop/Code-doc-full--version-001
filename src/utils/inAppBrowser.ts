// Detect social in-app browsers (Facebook / Instagram webviews), whose
// audio and media behavior is restricted compared with a full browser.
// Pure functions over a UA string so they can be unit-tested in isolation.

export type InAppBrowserApp = "facebook" | "instagram";

/** Which social in-app browser this UA belongs to, or null for a full browser. */
export function detectInAppBrowser(ua: string): InAppBrowserApp | null {
  if (!ua) return null;
  if (/instagram/i.test(ua)) return "instagram";
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "facebook";
  return null;
}

/** True for Android UAs (where an intent link can break out to the browser). */
export function isAndroidUa(ua: string): boolean {
  return /android/i.test(ua);
}

/**
 * Intent URL that opens gradevibes.com in the device's default browser app.
 * No browser package is pinned, so it resolves to whatever browser the
 * user has set as default rather than assuming Chrome. It carries
 * ?tab=upload so the break-out lands on the Upload ZIP Codebase tab
 * (GitHub URL import) instead of the default New App Builder tab.
 */
export function externalBrowserUrl(): string {
  return "intent://gradevibes.com/?tab=upload#Intent;scheme=https;action=android.intent.action.VIEW;end";
}
