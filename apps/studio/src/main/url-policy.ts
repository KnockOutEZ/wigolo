/**
 * One url-narrowing rule for every record the main process keeps or hands out.
 *
 * A query string can carry a secret on ANY page — an SSO or password-reset token, a session id, a
 * pre-signed object url — and none of those pages look credential-bearing to a classifier, so the rule
 * is applied UNCONDITIONALLY rather than decided per page. Forensics, replay and the timeline need the
 * origin; nothing downstream needs what follows it.
 */

/**
 * Origin (scheme+host+port) of a url — drops path, query and fragment.
 *
 * A url the parser rejects is NOT handed back whole: it is cut at the first `?`/`#` instead. "Unparseable"
 * is not "harmless" — `https://host:notaport/reset?token=…` throws for a reason that has nothing to do
 * with its query, and returning it verbatim would put the token in the very record this exists to keep it
 * out of. The cut is a floor, not a parse: it can leave a path behind, and never a query.
 */
export function originOnly(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    const cut = url.split(/[?#]/)[0];
    return cut ?? url;
  }
}
