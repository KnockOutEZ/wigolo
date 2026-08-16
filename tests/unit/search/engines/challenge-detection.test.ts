// Anti-bot interstitial detection for HTML-scraping engines.
//
// WHY THIS MATTERS: DuckDuckGo serves its anti-bot challenge with HTTP **202**
// and an `anomaly-modal` body. `Response.ok` is TRUE for 202, so the adapters'
// `if (!response.ok) throw` never fires — the parser finds no rows and the
// engine reports a SUCCESSFUL, EMPTY result set.
//
// Every recovery mechanism the engine pool owns is keyed on a thrown error:
// the circuit breaker, the in-call retry, the user-agent rotation that clears
// most transient blocks, and the `engine_warnings` surface callers branch on.
// A challenge that never throws bypasses all four. The engine stays dark for
// the rest of the process, the pool silently shrinks around it (measured live:
// the general pool falling from 4 engines to bing-alone), and the response
// still claims the engine was `ok`. That is the pool-collapse mechanism.
//
// Detection must be POSITIVE — a status code plus a structural markup marker.
// Keying on "zero results parsed" instead would fire on any genuinely empty
// result set (a narrow `site:` query), and keying on page TEXT would fire on a
// real results page about captchas.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectEngineChallenge,
  CHALLENGE_MARKER_ANOMALY_MODAL,
} from '../../../../src/search/engines/challenge.js';
import { isBlockedError } from '../../../../src/search/engines/user-agents.js';
import { classifyFailure, wrapWithRetryAndBreaker, resetBreakers } from '../../../../src/search/core/engine-base.js';
import { DuckDuckGoEngine } from '../../../../src/search/engines/duckduckgo.js';
import { BingEngine } from '../../../../src/search/engines/bing.js';
import { MojeekEngine } from '../../../../src/search/engines/mojeek.js';

// Verbatim shape of the live DuckDuckGo interstitial (captured 2026-08-16):
// HTTP 202, ~14 KB, an `anomaly-modal` puzzle and zero `result-link` anchors.
const DDG_CHALLENGE_BODY = `<!DOCTYPE html><html lang="en"><head><title>DuckDuckGo</title></head>
<body><div class="anomaly-modal__mask"></div>
<div class="anomaly-modal__modal"><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<div class="anomaly-modal__puzzle"></div></div></body></html>`;

const DDG_RESULTS_BODY = `<html><body><table>
<tr><td><a class="result-link" href="https://react.dev/learn">React - Learn</a></td></tr>
<tr><td class="result-snippet">The official React docs.</td></tr>
</table></body></html>`;

// A REAL results page ABOUT anti-bot pages. Every hostile word appears in the
// visible prose. Detection keyed on page text rather than markup structure
// would take a healthy engine out of the pool on this query.
const DDG_RESULTS_ABOUT_CAPTCHAS = `<html><body><table>
<tr><td><a class="result-link" href="https://example.com/captcha">Solving captcha and unusual traffic blocks</a></td></tr>
<tr><td class="result-snippet">Why you are blocked by an anomaly detector: bot traffic, rate limit, and captcha challenges explained.</td></tr>
</table></body></html>`;

describe('detectEngineChallenge', () => {
  it('flags an HTTP 202 from an HTML search endpoint as a challenge', () => {
    // No search endpoint answers a query with 202 Accepted. This is the exact
    // status DuckDuckGo uses for its interstitial, and the one that slips
    // past `Response.ok`.
    expect(detectEngineChallenge('DDG', 202, DDG_CHALLENGE_BODY)).not.toBeNull();
  });

  it('flags the anomaly-modal markup even on a 200', () => {
    expect(detectEngineChallenge('DDG', 200, DDG_CHALLENGE_BODY)).not.toBeNull();
    expect(DDG_CHALLENGE_BODY).toContain(CHALLENGE_MARKER_ANOMALY_MODAL);
  });

  it('does NOT fire on a normal results page', () => {
    expect(detectEngineChallenge('DDG', 200, DDG_RESULTS_BODY)).toBeNull();
  });

  // Over-fire probe. A results page whose prose is entirely about captchas,
  // blocks, rate limits and anomalies must stay usable.
  it('does NOT fire on a results page whose text is about captchas and blocks', () => {
    expect(detectEngineChallenge('DDG', 200, DDG_RESULTS_ABOUT_CAPTCHAS)).toBeNull();
  });

  // Must-not-fire on an ordinary empty page: "zero results" is a legitimate
  // outcome (a narrow site: scope), not evidence of a block.
  it('does NOT fire on an empty but well-formed 200 page', () => {
    expect(detectEngineChallenge('DDG', 200, '<html><body></body></html>')).toBeNull();
  });

  // The message is the ONLY channel the breaker and the UA rotator read. If it
  // does not classify as a blocked, transient failure, the fix is inert: the
  // fingerprint never rotates and the engine takes the hard-failure backoff
  // ladder for a block that clears in seconds.
  it('produces a message that routes to UA rotation and the transient cooldown', () => {
    const message = detectEngineChallenge('DDG', 202, DDG_CHALLENGE_BODY);
    expect(message).not.toBeNull();
    expect(isBlockedError(new Error(message!))).toBe(true);
    expect(classifyFailure(new Error(message!))).toBe('rate-limit');
  });

  it('names the engine in the message so engine_warnings is attributable', () => {
    expect(detectEngineChallenge('Mojeek', 202, '')).toContain('Mojeek');
  });
});

describe('HTML-scraping engines reject a 2xx interstitial', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBreakers();
  });

  const challengeResponse = (): Response =>
    new Response(DDG_CHALLENGE_BODY, { status: 202 });

  it('DuckDuckGo throws instead of reporting a successful empty result set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(challengeResponse()));
    await expect(new DuckDuckGoEngine().search('react useState')).rejects.toThrow(/challenge/i);
  });

  it('Bing throws on a 202 interstitial', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html></html>', { status: 202 })));
    await expect(new BingEngine().search('react useState')).rejects.toThrow(/challenge/i);
  });

  it('Mojeek throws on a 202 interstitial', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html></html>', { status: 202 })));
    await expect(new MojeekEngine().search('react useState')).rejects.toThrow(/challenge/i);
  });

  it('still parses a normal 200 results page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DDG_RESULTS_BODY, { status: 200 })));
    const results = await new DuckDuckGoEngine().search('react useState');
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://react.dev/learn');
  });

  // The payoff test. A silent empty result set is dispatched ONCE and the
  // fingerprint is never rotated, so a blocked engine can never recover inside
  // the call. A thrown challenge re-enters the retry loop with a fresh
  // fingerprint — the one mechanism that clears most transient blocks.
  it('re-dispatches a challenged engine with a rotated fingerprint', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => challengeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const wrapped = wrapWithRetryAndBreaker(new DuckDuckGoEngine());
    await expect(wrapped.search('react useState')).rejects.toThrow(/challenge/i);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const agents = fetchMock.mock.calls.map(
      (c) => (c[1] as { headers: Record<string, string> }).headers['User-Agent'],
    );
    expect(new Set(agents).size).toBeGreaterThan(1);
  });
});
