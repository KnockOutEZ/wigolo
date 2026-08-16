// Anti-bot interstitial detection for the HTML-scraping search engines.
//
// WHY: DuckDuckGo serves its anti-bot challenge with HTTP 202 and an
// `anomaly-modal` body. `Response.ok` is TRUE for 202, so the adapters'
// `if (!response.ok) throw` never fires: the parser finds no rows and the
// engine reports a SUCCESSFUL, EMPTY result set.
//
// Every recovery mechanism the pool owns is keyed on a thrown error — the
// circuit breaker, the in-call retry, the user-agent rotation that clears most
// transient blocks, and the `engine_warnings` surface callers branch on. A
// challenge that never throws bypasses all four: the engine stays dark for the
// rest of the process, the pool shrinks around it, and the response still
// reports the engine as `ok`.
//
// Detection is POSITIVE: a status code plus a structural markup marker.
//   * Keying on "the parser returned zero rows" would fire on any genuinely
//     empty result set (a narrow `site:` scope) and take a healthy engine out.
//   * Keying on page TEXT ("captcha", "unusual traffic", "blocked") would fire
//     on a real results page whose snippets are about anti-bot pages.
// Both are the caller's own query talking back at us, so neither is evidence.

/** Structural marker of the DuckDuckGo interstitial: the CSS class prefix of
 * its challenge modal. A class-attribute token, not prose — a results page
 * about anti-bot systems cannot produce it. */
export const CHALLENGE_MARKER_ANOMALY_MODAL = 'anomaly-modal__';

/** Statuses that are a challenge by construction on an HTML search endpoint.
 * 202 Accepted is meaningless for a synchronous search — no engine answers a
 * query with it — and it is the status DuckDuckGo's interstitial arrives on. */
const CHALLENGE_STATUSES = new Set([202]);

/**
 * Return an error message when `status` + `body` are an anti-bot interstitial
 * rather than a result page, or `null` when the response looks legitimate.
 *
 * The message is worded so the shared failure classifiers route it correctly:
 * `isBlockedError` must see it as retryable-with-a-fresh-fingerprint, and
 * `classifyFailure` must class it as `rate-limit` — the engine is UP and
 * throttling this caller, so it takes the short transient cooldown and never
 * feeds the chronic-failure ladder.
 */
export function detectEngineChallenge(
  engine: string,
  status: number,
  body: string,
): string | null {
  if (CHALLENGE_STATUSES.has(status)) {
    return `${engine} returned an anti-bot challenge (HTTP ${status}, rate limit)`;
  }
  if (body.includes(CHALLENGE_MARKER_ANOMALY_MODAL)) {
    return `${engine} returned an anti-bot challenge page (rate limit)`;
  }
  return null;
}
