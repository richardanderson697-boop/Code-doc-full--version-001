// Which price list the Buy-credits modal shows.
//
// Pricing audience follows the view you're in — never sticky — plus the
// sales-home rule: on getfinalread.com (or the staging host that serves
// it) the visitor is a FinalRead buyer, so pricing defaults to the
// FinalRead list even before the entry opens. The homepage itself is
// unchanged (direct FinalRead landing stays deferred); this only decides
// which packs the modal lists.
//
// Everything here is pure so it can be unit-tested without a DOM.

/** Exact hostnames that always sell the FinalRead review. */
export const FINALREAD_PRICING_HOSTS: readonly string[] = ["getfinalread.com"];

/**
 * True for a FinalRead sales-home host: getfinalread.com, or any Railway
 * app URL (the staging service is served on *.up.railway.app; the
 * production service is reached via gradevibes.com, never its Railway
 * URL). A generated Railway subdomain is not hardcoded — the suffix
 * covers it if the service is ever renamed.
 */
export function isFinalReadPricingHost(hostname: string): boolean {
  if (FINALREAD_PRICING_HOSTS.includes(hostname)) return true;
  return hostname.endsWith(".up.railway.app");
}

/** The modal's audience: "finalread" in the FinalRead entry or on a
 *  FinalRead sales-home host, consumer packs everywhere else. */
export function pricingAudienceFor(
  finalreadEntryOpen: boolean,
  hostname: string
): "finalread" | undefined {
  return finalreadEntryOpen || isFinalReadPricingHost(hostname) ? "finalread" : undefined;
}
