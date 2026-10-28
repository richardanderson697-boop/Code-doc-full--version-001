// In-app browser detection: the break-out banner must fire inside
// Facebook/Instagram webviews and stay quiet in full browsers, or it
// nags exactly the users who need nothing.
import { describe, it, expect } from "vitest";
import {
  detectInAppBrowser,
  isAndroidUa,
  externalBrowserUrl,
} from "../src/utils/inAppBrowser";

const FB_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/418.0.0.0.0]";
const FB_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.0.0 Mobile Safari/537.36 [FBAN/FB4A;FBAV/418.0.0.0.0]";
const IG_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.0.0";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DESKTOP_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MOBILE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

describe("detectInAppBrowser", () => {
  it("detects Facebook iOS and Android webviews", () => {
    expect(detectInAppBrowser(FB_IOS)).toBe("facebook");
    expect(detectInAppBrowser(FB_ANDROID)).toBe("facebook");
  });

  it("detects the Instagram webview", () => {
    expect(detectInAppBrowser(IG_IOS)).toBe("instagram");
  });

  it("stays quiet in full browsers", () => {
    expect(detectInAppBrowser(DESKTOP_CHROME)).toBeNull();
    expect(detectInAppBrowser(DESKTOP_SAFARI)).toBeNull();
    expect(detectInAppBrowser(MOBILE_SAFARI)).toBeNull();
    expect(detectInAppBrowser(ANDROID_CHROME)).toBeNull();
    expect(detectInAppBrowser("")).toBeNull();
  });
});

describe("isAndroidUa / externalBrowserUrl", () => {
  it("distinguishes Android from iOS", () => {
    expect(isAndroidUa(FB_ANDROID)).toBe(true);
    expect(isAndroidUa(ANDROID_CHROME)).toBe(true);
    expect(isAndroidUa(FB_IOS)).toBe(false);
    expect(isAndroidUa(MOBILE_SAFARI)).toBe(false);
  });

  it("builds a package-free intent URL for the default browser", () => {
    const url = externalBrowserUrl();
    expect(url.startsWith("intent://gradevibes.com")).toBe(true);
    expect(url).toContain("scheme=https");
    expect(url).toContain("android.intent.action.VIEW");
    expect(url).not.toContain("package=");
  });
});
