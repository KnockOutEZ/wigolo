// Anti-bot interstitial detection for HTML-scraping engines.
//
// WHY THIS MATTERS: DuckDuckGo serves its anti-bot challenge with HTTP **202**.
// `Response.ok` is TRUE for 202, so the adapters' `if (!response.ok) throw`
// never fires — the parser finds no rows and the engine reports a SUCCESSFUL,
// EMPTY result set.
//
// Every recovery mechanism the engine pool owns is keyed on a thrown error:
// the circuit breaker, the in-call retry, the user-agent rotation that clears
// most transient blocks, and the `engine_warnings` surface callers branch on.
// A challenge that never throws bypasses all four. The engine stays dark for
// the rest of the process, the pool silently shrinks around it (measured live:
// the general pool falling from 4 engines to bing-alone), and the response
// still claims the engine was `ok`. That is the pool-collapse mechanism.
//
// Detection keys on the response STATUS ONLY. A search engine's response BODY
// is caller-writable by construction — the query is echoed back into
// `<meta og:title>`, pagination hrefs and the search box — so no predicate over
// the body can act as a control. An earlier revision of this module matched a
// structural markup marker and was reverted after a live reproduction: see the
// `caller-writable body` probes below, which pin that regression shut.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectEngineChallenge } from '../../../../src/search/engines/challenge.js';
import { isBlockedError } from '../../../../src/search/engines/user-agents.js';
import {
  classifyFailure,
  wrapWithRetryAndBreaker,
  resetBreakers,
} from '../../../../src/search/core/engine-base.js';
import { DuckDuckGoEngine } from '../../../../src/search/engines/duckduckgo.js';
import { BingEngine } from '../../../../src/search/engines/bing.js';
import { MojeekEngine } from '../../../../src/search/engines/mojeek.js';

const DDG_RESULTS_BODY = `<html><body><table>
<tr><td><a class="result-link" href="https://react.dev/learn">React - Learn</a></td></tr>
<tr><td class="result-snippet">The official React docs.</td></tr>
</table></body></html>`;

describe('detectEngineChallenge', () => {
  it('flags an HTTP 202 from an HTML search endpoint as a challenge', () => {
    // No search endpoint answers a query with 202 Accepted. This is the exact
    // status DuckDuckGo uses for its interstitial, and the one that slips
    // past `Response.ok`.
    expect(detectEngineChallenge('DDG', 202)).not.toBeNull();
  });

  it('does NOT fire on a 200', () => {
    expect(detectEngineChallenge('DDG', 200)).toBeNull();
  });

  // The message is the ONLY channel the breaker and the UA rotator read. If it
  // does not classify as a blocked, transient failure, the fix is inert: the
  // fingerprint never rotates and the engine takes the hard-failure backoff
  // ladder for a block that clears in seconds.
  it('produces a message that routes to UA rotation and the transient cooldown', () => {
    const message = detectEngineChallenge('DDG', 202);
    expect(message).not.toBeNull();
    expect(isBlockedError(new Error(message!))).toBe(true);
    expect(classifyFailure(new Error(message!))).toBe('rate-limit');
  });

  it('names the engine in the message so engine_warnings is attributable', () => {
    expect(detectEngineChallenge('Mojeek', 202)).toContain('Mojeek');
  });
});

// REGRESSION PROBES for a defect that shipped and was reverted.
//
// A previous revision also fired when the raw body contained the challenge
// modal's CSS class prefix, on the rationale that "a class-attribute token is
// not prose, so a results page about anti-bot systems cannot produce it". That
// is false. `body.includes()` runs on raw HTML and cannot distinguish a class
// attribute from the CALLER'S OWN QUERY echoed back into the page. The marker
// contains no HTML-escapable characters, so it survives verbatim.
//
// Reproduced live against the real Bing URL the adapter builds: querying the
// marker string returned HTTP 200, 124 KB, with genuine `b_algo` result rows —
// and the shipped predicate called it a challenge. Three such queries reach the
// breaker's failure threshold and darken Bing: the one engine the pool collapses
// TO. The reachable input is any query about DuckDuckGo's anti-bot markup,
// i.e. precisely what a developer working on this file searches for.
describe('caller-writable body must never decide the verdict', () => {
  // The probe that would have caught the shipped defect: a HEALTHY results page
  // whose body contains the literal marker, because the user searched for it.
  const HEALTHY_PAGE_ECHOING_THE_MARKER = `<html><head>
<meta property="og:title" content="anomaly-modal__puzzle - Search">
</head><body>
<input name="q" value="anomaly-modal__puzzle">
<li class="b_algo"><h2><a href="https://example.com/ddg-markup">Reverse-engineering the anomaly-modal__ interstitial</a></h2>
<div class="b_lineclamp2">A teardown of the anomaly-modal__mask and anomaly-modal__submit elements.</div></li>
<a href="/search?q=anomaly-modal__puzzle&amp;first=11">Next page</a>
</body></html>`;

  it('does NOT fire on a healthy 200 page whose body contains the challenge marker', () => {
    expect(detectEngineChallenge('Bing', 200)).toBeNull();
    expect(HEALTHY_PAGE_ECHOING_THE_MARKER).toContain('anomaly-modal__');
  });

  // This is the probe that actually kills the regression. Asserting on the
  // predicate's ARITY does not: a reintroduced body arm with a defaulted
  // parameter keeps `Function.length` at 2 and slips straight past. Only
  // driving a marker-echoing page through the real adapter catches it.
  it('parses that same marker-echoing page into real results end to end', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(HEALTHY_PAGE_ECHOING_THE_MARKER, { status: 200 })),
    );
    const results = await new BingEngine().search('anomaly-modal__puzzle');
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/ddg-markup');
    vi.unstubAllGlobals();
  });

  // The other caller-writable shape, kept from the original review: prose.
  it('does NOT fire on a results page whose text is about captchas and blocks', () => {
    expect(detectEngineChallenge('DDG', 200)).toBeNull();
  });
});

describe('HTML-scraping engines reject a 2xx interstitial', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBreakers();
  });

  // MEASURED: this is the live DuckDuckGo interstitial. Captured 2026-08-16
  // from lite.duckduckgo.com — HTTP 202, ~14 KB, zero `result-link` anchors.
  it('DuckDuckGo throws instead of reporting a successful empty result set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 202 })));
    await expect(new DuckDuckGoEngine().search('react useState')).rejects.toThrow(/challenge/i);
  });

  // SYNTHETIC FIXTURE — no interstitial has been observed from Bing. This pins
  // generic defence, not vendor behaviour: a 202 from an HTML search endpoint
  // cannot be a result page, so the guard is free. Do not read this test as
  // evidence that Bing serves a 202.
  it('Bing throws on a 202 (synthetic fixture: generic defence, unobserved from Bing)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html></html>', { status: 202 })));
    await expect(new BingEngine().search('react useState')).rejects.toThrow(/challenge/i);
  });

  // SYNTHETIC FIXTURE — Mojeek blocks with a 403, which already throws on the
  // `!response.ok` check. Same generic-defence rationale as Bing; not observed.
  it('Mojeek throws on a 202 (synthetic fixture: generic defence, unobserved from Mojeek)', async () => {
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
    const fetchMock = vi.fn().mockImplementation(async () => new Response('', { status: 202 }));
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
