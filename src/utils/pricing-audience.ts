// Which host this is: the FinalRead buyer entrance or the GradeVibes
// developer workspace.
//
// Two-sided flow spec Rev 3 (§1): ONE entrance predicate decides the
// host. getfinalread.com (or the staging host that serves it) is the
// buyer greeting — no workspace, no builder, no upload. gradevibes.com
// is the developer workspace. The pricing audience follows the same
// predicate: on a FinalRead host the visitor is a FinalRead buyer, so
// pricing defaults to the FinalRead list.
//
// Everything here is pure so it can be unit-tested without a DOM.

/** Exact hostnames that always serve the FinalRead buyer entrance. */
export const FINALREAD_PRICING_HOSTS: readonly string[] = ["getfinalread.com"];

/**
 * The entrance predicate (two-sided flow §1): true for a FinalRead host
 * — getfinalread.com, or any Railway app URL (the staging service is
 * served on *.up.railway.app; the production service is reached via
 * gradevibes.com, never its Railway URL). A generated Railway subdomain
 * is not hardcoded — the suffix covers it if the service is ever
 * renamed.
 */
export function isFinalReadHost(hostname: string): boolean {
  if (FINALREAD_PRICING_HOSTS.includes(hostname)) return true;
  return hostname.endsWith(".up.railway.app");
}

/** Backwards-compatible alias: the old pricing-host name. */
export const isFinalReadPricingHost = isFinalReadHost;

/** The modal's audience: "finalread" in the FinalRead entry or on a
 *  FinalRead sales-home host, consumer packs everywhere else. */
export function pricingAudienceFor(
  finalreadEntryOpen: boolean,
  hostname: string
): "finalread" | undefined {
  return finalreadEntryOpen || isFinalReadHost(hostname) ? "finalread" : undefined;
}
