// Shared rotating browser user-agent pool for HTML-scraping search engines.
//
// WHY: engines that scrape HTML (bing, duckduckgo, mojeek) get blocked with a
// 403 on IP/fingerprint reputation. A single hardcoded user agent has no way
// to recover; presenting a DIFFERENT browser fingerprint on retry clears many
// transient blocks. This pool is shared and applied by error class (403 /
// blocked) across every HTML-scraping engine, so the rotation is a
// pattern-level capability rather than a per-engine special case.

export const USER_AGENT_POOL: readonly string[] = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

/**
 * Pick a user agent for the next request. When `previous` is supplied the
 * result is guaranteed to differ from it, so a retry always presents a fresh
 * fingerprint; successive calls cycle deterministically through the pool. With
 * no previous UA a random pool member is returned so cold requests spread
 * across fingerprints.
 */
export function nextUserAgent(previous?: string): string {
  if (previous === undefined) {
    return USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)];
  }
  const idx = USER_AGENT_POOL.indexOf(previous);
  if (idx === -1) {
    return USER_AGENT_POOL[0];
  }
  return USER_AGENT_POOL[(idx + 1) % USER_AGENT_POOL.length];
}

/**
 * True when an engine error looks like a block the client can retry against
 * with a fresh fingerprint — an upstream 403 (forbidden / reputation), 429
 * (rate limit), 202, or a captcha/challenge interstitial. Keyed on error
 * class, never on a specific engine.
 */
export function isBlockedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /\b(202|403|429)\b/.test(message) ||
    /forbidden|blocked|rate.?limit|captcha|challenge/i.test(message)
  );
}

/**
 * True when an HTML search response is a captcha / bot-check interstitial
 * rather than a result page. Captcha bodies used to parse as zero results
 * with outcome=ok, which made the pool look healthy while only Bing scored.
 */
export function isCaptchaHtml(html: string): boolean {
  if (!html) return false;
  const sample = html.slice(0, 8000).toLowerCase();
  return (
    /<title>\s*captcha\s*<\/title>/.test(sample) ||
    /select all squares containing/.test(sample) ||
    /please verify you are (a )?human/.test(sample) ||
    /cf-challenge|challenge-form|hcaptcha|g-recaptcha/.test(sample)
  );
}
