// Anti-bot interstitial detection for the HTML-scraping search engines.
//
// WHY: DuckDuckGo serves its anti-bot challenge with HTTP 202. `Response.ok`
// is TRUE for 202, so the adapters' `if (!response.ok) throw` never fires: the
// parser finds no rows and the engine reports a SUCCESSFUL, EMPTY result set.
//
// Every recovery mechanism the pool owns is keyed on a thrown error — the
// circuit breaker, the in-call retry, the user-agent rotation that clears most
// transient blocks, and the `engine_warnings` surface callers branch on. A
// challenge that never throws bypasses all four: the engine stays dark for the
// rest of the process, the pool shrinks around it, and the response still
// reports the engine as `ok`.
//
// Detection keys on the RESPONSE STATUS ONLY. Three richer-looking signals were
// tried and rejected, all for the same reason — each decides on content the
// CALLER can write:
//   * "the parser returned zero rows" fires on any genuinely empty result set
//     (a narrow `site:` scope) and takes a healthy engine out.
//   * page TEXT ("captcha", "unusual traffic", "blocked") fires on a real
//     results page whose snippets are about anti-bot pages.
//   * a structural MARKUP marker (the challenge modal's CSS class prefix) was
//     shipped and then removed: `body.includes()` runs on raw HTML and cannot
//     tell a class attribute from the query echoed back into `<meta og:title>`,
//     pagination hrefs, and the search box. The marker contains no
//     HTML-escapable characters, so it survives verbatim. Measured live:
//     searching Bing for the marker string returns HTTP 200 with real result
//     rows and a body containing the marker — three such queries hit the
//     breaker's failure threshold and darken Bing, the very engine the pool
//     collapses to. A search engine's response body is caller-writable by
//     construction; no predicate over it can be a control.
//
// The status is not caller-writable, which is the whole point.

/** Statuses that are a challenge by construction on an HTML search endpoint.
 * 202 Accepted is meaningless for a synchronous search — no engine answers a
 * query with it — and it is the status DuckDuckGo's interstitial arrives on. */
const CHALLENGE_STATUSES = new Set([202]);

/**
 * Return an error message when `status` is an anti-bot interstitial rather
 * than a result page, or `null` when the response looks legitimate.
 *
 * The message is worded so the shared failure classifiers route it correctly:
 * `isBlockedError` must see it as retryable-with-a-fresh-fingerprint, and
 * `classifyFailure` must class it as `rate-limit` — the engine is UP and
 * throttling this caller, so it takes the short transient cooldown and never
 * feeds the chronic-failure ladder.
 */
export function detectEngineChallenge(engine: string, status: number): string | null {
  if (CHALLENGE_STATUSES.has(status)) {
    return `${engine} returned an anti-bot challenge (HTTP ${status}, rate limit)`;
  }
  return null;
}
