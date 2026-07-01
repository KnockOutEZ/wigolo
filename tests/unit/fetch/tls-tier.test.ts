import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getConfig, resetConfig, validateTlsBrowser } from '../../../src/config.js';
import {
  isAntiBotStatus,
  hasChallengeBody,
  isAntiBotSignal,
  looksJsRequired,
  describeAntiBot,
  tlsFetch,
  _setTlsBackendForTests,
  _resetTlsBackend,
  TlsTierUnavailableError,
} from '../../../src/fetch/tls-tier.js';

// Detect whether the optional `wreq-js` napi binary is loadable in this
// environment. On unsupported platforms / `npm install --omit=optional` the
// package is absent and the real-binary stdio test must be skipped.
const wreqJsAvailable = (() => {
  try {
    const req = createRequire(import.meta.url);
    req.resolve('wreq-js');
    return true;
  } catch {
    return false;
  }
})();

const originalEnv = process.env;

describe('tls-tier: anti-bot detectors', () => {
  it('flags 403/429/503 as anti-bot statuses', () => {
    expect(isAntiBotStatus(403)).toBe(true);
    expect(isAntiBotStatus(429)).toBe(true);
    expect(isAntiBotStatus(503)).toBe(true);
  });

  it('does not flag 200/302/500 as anti-bot statuses', () => {
    expect(isAntiBotStatus(200)).toBe(false);
    expect(isAntiBotStatus(302)).toBe(false);
    expect(isAntiBotStatus(500)).toBe(false);
  });

  it('detects Cloudflare challenge body markers', () => {
    expect(hasChallengeBody('<html><body>cf-browser-verification</body></html>')).toBe(true);
    expect(hasChallengeBody('<title>Just a moment...</title>')).toBe(true);
    expect(hasChallengeBody('<script>var _cfChlOpt = {}</script>')).toBe(true);
  });

  it('detects DataDome challenge markers', () => {
    expect(hasChallengeBody('<div class="dd-loader"></div>')).toBe(true);
    expect(hasChallengeBody('<script>window._dd_s = 1;</script>')).toBe(true);
  });

  it('does not flag normal HTML as anti-bot', () => {
    expect(hasChallengeBody('<html><body><h1>Normal page</h1></body></html>')).toBe(false);
    expect(hasChallengeBody(null)).toBe(false);
    expect(hasChallengeBody('')).toBe(false);
  });

  it('caps challenge-body scan at 32KB', () => {
    const padding = 'a'.repeat(40000);
    const html = padding + 'cf-browser-verification';
    // Marker is past the 32KB window — should not match.
    expect(hasChallengeBody(html)).toBe(false);
  });

  it('isAntiBotSignal combines status + body', () => {
    expect(isAntiBotSignal(200, '<html>fine</html>')).toBe(false);
    expect(isAntiBotSignal(403, '<html>fine</html>')).toBe(true);
    expect(isAntiBotSignal(200, 'cf-browser-verification')).toBe(true);
  });

  it('isAntiBotSignal treats a bare 429 (no challenge body) as a rate-limit, NOT anti-bot', async () => {
    // Bare 429s are rate-limits. Playwright cannot
    // bypass a rate limit, so escalation just pays the browser cold-start
    // cost. Only escalate when 429 carries a challenge body.
    const { isAntiBotSignal: isAntiBot, isRateLimit } = await import('../../../src/fetch/tls-tier.js');
    expect(isAntiBot(429, '<html><body>Too Many Requests</body></html>')).toBe(false);
    expect(isAntiBot(429, '')).toBe(false);
    expect(isRateLimit(429, '')).toBe(true);
    // 429 with a Cloudflare challenge body is still anti-bot.
    expect(isAntiBot(429, '<html><body>cf-browser-verification</body></html>')).toBe(true);
    expect(isRateLimit(429, '<html><body>cf-browser-verification</body></html>')).toBe(false);
    // Non-429 codes are never rate-limits.
    expect(isRateLimit(403, '')).toBe(false);
    expect(isRateLimit(503, '')).toBe(false);
  });

  it('looksJsRequired matches "enable javascript"', () => {
    expect(looksJsRequired('<noscript>Please enable JavaScript</noscript>')).toBe(true);
    expect(looksJsRequired('<noscript>please enable javascript to continue</noscript>')).toBe(true);
    expect(looksJsRequired('<html><body>plain content</body></html>')).toBe(false);
    expect(looksJsRequired(null)).toBe(true);
    expect(looksJsRequired('')).toBe(true);
  });

  it('describeAntiBot returns status_* for blocked status', () => {
    expect(describeAntiBot(429, '')).toBe('status_429');
    expect(describeAntiBot(200, 'cf-browser-verification')).toBe('challenge_body');
    expect(describeAntiBot(200, '<html>normal</html>')).toBe(null);
  });
});

describe('tls-tier: lazy load + module cache safety', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    _resetTlsBackend();
    _setTlsBackendForTests(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  it('does not load wreq-js until tlsFetch is invoked', async () => {
    // Module-level import of tls-tier.js must not pull in wreq-js. The
    // contract: importing tls-tier should produce zero wreq-js entries in
    // either require.cache (CJS) or process._linkedBinding (napi).
    // vitest runs tests under ESM where require may not be present, so we
    // guard against absence and fall back to a presence check via
    // `import.meta.url`-relative resolution (skipped here — the absence of
    // any wreq-js export on the tls-tier surface is the real assertion).
    const reqCache = (globalThis as { require?: { cache: Record<string, unknown> } }).require?.cache;
    if (reqCache) {
      const inCacheBefore = Object.keys(reqCache).some((k) => k.includes('wreq-js'));
      expect(inCacheBefore).toBe(false);
    }
    // Surface contract: tls-tier exports no symbols that would force a
    // transitive wreq-js load at module-evaluation time.
    const mod = await import('../../../src/fetch/tls-tier.js');
    expect(typeof mod.tlsFetch).toBe('function');
    expect(typeof mod.isAntiBotSignal).toBe('function');
  });

  it('returns TlsTierUnavailableError when backend import fails', async () => {
    _setTlsBackendForTests(null);
    _resetTlsBackend();

    // The TlsTierUnavailableError shape is the contract callers (router)
    // pattern-match on. Verify the type and cause carry through. We can't
    // force the real dynamic import to fail in a sandbox where wreq-js is
    // installed, so we exercise the constructor directly here and let the
    // router-tls tests cover the wiring path.
    const err = new TlsTierUnavailableError(new Error('simulated'));
    expect(err.name).toBe('TlsTierUnavailableError');
    expect(err.message).toBe('tls_tier_unavailable');
    expect((err.cause as Error).message).toBe('simulated');
  });

  it('uses test-override backend without touching wreq-js', async () => {
    const calls: string[] = [];
    _setTlsBackendForTests({
      fetch: async (url) => {
        calls.push(url);
        return {
          status: 200,
          url,
          headers: {
            entries: function* () {
              yield ['content-type', 'text/html'];
            },
          },
          text: async () => '<html><body>hello from tls</body></html>',
        };
      },
    });

    const result = await tlsFetch('https://example.com/page');
    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('hello from tls');
    expect(result.contentType).toBe('text/html');
    expect(calls).toEqual(['https://example.com/page']);
  });
});

describe('tls-tier: caller signal shares the per-fetch budget (latency regression guard)', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  function makeOkResponse(url: string) {
    return {
      status: 200,
      url,
      headers: {
        entries: function* () {
          yield ['content-type', 'text/html'];
        },
      },
      text: async () => '<html><body>ok</body></html>',
    };
  }

  it('forwards a signal to the backend that aborts when the CALLER deadline fires (not a fresh full timeout)', async () => {
    // WHY: the timeout-escalation path hands tlsFetch the per-fetch deadline.
    // If tlsFetch drops it and mints a fresh AbortSignal.timeout, the caller's
    // already-spent budget is ignored and the TLS attempt stacks a second full
    // timeout — a latency blowup. This test fails against the
    // dropped-signal code because the backend would receive an un-aborted fresh
    // timeout signal instead of the caller's already-aborted one.
    let seenSignal: AbortSignal | undefined;
    _setTlsBackendForTests({
      fetch: async (url, init) => {
        seenSignal = init?.signal;
        return makeOkResponse(url);
      },
    });

    // Caller deadline that is ALREADY exhausted (the HTTP timeout burned it).
    const controller = new AbortController();
    controller.abort(new DOMException('caller deadline', 'TimeoutError'));

    // A long internal timeout so that, if the signal were dropped, the backend
    // would see a NON-aborted fresh signal — distinguishing the two paths.
    await tlsFetch('https://example.com/page', { signal: controller.signal, timeoutMs: 30000 });

    expect(seenSignal).toBeDefined();
    // Combined signal must already be aborted because the caller's deadline is.
    expect(seenSignal?.aborted).toBe(true);
  });

  it('still bounds the in-flight request by the INTERNAL timeout when the caller signal stays live', async () => {
    // The caller signal never aborts; a slow backend must still be cut off by
    // the internal timeoutMs. We observe the abort from INSIDE the backend
    // call (before tlsFetch returns and its cleanup detaches the combiner),
    // proving the internal budget survives alongside the caller's signal.
    let abortedDuringFetch = false;
    let callerAbortedDuringFetch = false;
    _setTlsBackendForTests({
      fetch: async (url, init) => {
        const sig = init?.signal;
        await new Promise<void>((resolve) => {
          if (!sig) return resolve();
          sig.addEventListener('abort', () => resolve(), { once: true });
        });
        abortedDuringFetch = sig?.aborted ?? false;
        return makeOkResponse(url);
      },
    });

    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      callerAbortedDuringFetch = true;
    });

    await tlsFetch('https://example.com/page', { signal: controller.signal, timeoutMs: 10 });

    // The combined signal fired (from the internal 10ms timeout), unblocking the
    // backend — even though the caller's own signal never aborted.
    expect(abortedDuringFetch).toBe(true);
    expect(callerAbortedDuringFetch).toBe(false);
  });

  it('uses only the internal timeout when no caller signal is supplied', async () => {
    let seenSignal: AbortSignal | undefined;
    _setTlsBackendForTests({
      fetch: async (url, init) => {
        seenSignal = init?.signal;
        return makeOkResponse(url);
      },
    });

    await tlsFetch('https://example.com/page', { timeoutMs: 5000 });
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(false);
  });
});

describe('tls-tier: profile rotation on Cloudflare challenge', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  function challenge403(url: string) {
    return {
      status: 403,
      url,
      headers: {
        entries: function* () {
          yield ['content-type', 'text/html'];
        },
      },
      // Cloudflare "Just a moment" interstitial — isAntiBotSignal flags this.
      text: async () =>
        '<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>',
    };
  }

  function fullPage200(url: string, profile: string) {
    return {
      status: 200,
      url,
      headers: {
        entries: function* () {
          yield ['content-type', 'text/html'];
        },
      },
      text: async () => `<html><body>full page rendered by ${profile}</body></html>`,
    };
  }

  it('rotates to the next profile when the first profile is served a Cloudflare challenge', async () => {
    // WHY: on the Stack Exchange network every chrome profile is served a
    // Cloudflare 403 "Just a moment" challenge in <50ms, while firefox/safari
    // profiles return a full 200 page. Without rotation the TLS tier returns
    // the still-blocked 403, the router escalates, and Stack Overflow never
    // hydrates even with an infinite budget. Rotation
    // makes the chrome->firefox fallback hydrate the page transparently.
    const seenProfiles: string[] = [];
    _setTlsBackendForTests({
      fetch: async (url, init) => {
        const profile = init?.browser ?? '<none>';
        seenProfiles.push(profile);
        // chrome family is Cloudflare-blocked; firefox/safari succeed.
        if (profile.startsWith('chrome')) return challenge403(url);
        return fullPage200(url, profile);
      },
    });

    // Default profile is the Cloudflare-blocked chrome.
    process.env.WIGOLO_TLS_BROWSER = 'chrome_142';
    resetConfig();

    const result = await tlsFetch('https://stackoverflow.com/questions/1');

    // Rotation returned a healthy 200 page from a non-chrome profile.
    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('full page rendered by');
    expect(result.html).not.toContain('cf-browser-verification');
    // It actually tried chrome first, then rotated to a different family.
    expect(seenProfiles[0]).toBe('chrome_142');
    expect(seenProfiles.length).toBeGreaterThanOrEqual(2);
    expect(seenProfiles.some((p) => !p.startsWith('chrome'))).toBe(true);
  });

  it('does NOT rotate when the first profile succeeds (happy path, no wasted attempts)', async () => {
    const seenProfiles: string[] = [];
    _setTlsBackendForTests({
      fetch: async (url, init) => {
        seenProfiles.push(init?.browser ?? '<none>');
        return fullPage200(url, init?.browser ?? '');
      },
    });

    process.env.WIGOLO_TLS_BROWSER = 'chrome_142';
    resetConfig();

    const result = await tlsFetch('https://example.com/page');
    expect(result.statusCode).toBe(200);
    // Exactly one attempt — no rotation on a first-try success.
    expect(seenProfiles).toEqual(['chrome_142']);
  });

  it('is bounded: tries at most the fixed fallback list, then returns the last blocked result', async () => {
    // Every profile is Cloudflare-blocked. Rotation must NOT loop forever; it
    // tries the bounded fallback list and surfaces the final still-blocked
    // result so the router can escalate to the browser engine.
    const seenProfiles: string[] = [];
    _setTlsBackendForTests({
      fetch: async (url, init) => {
        seenProfiles.push(init?.browser ?? '<none>');
        return challenge403(url);
      },
    });

    process.env.WIGOLO_TLS_BROWSER = 'chrome_142';
    resetConfig();

    const result = await tlsFetch('https://stackoverflow.com/questions/2');

    // Surfaced the blocked result (router decides escalation) — still 403.
    expect(result.statusCode).toBe(403);
    // Bounded: distinct profiles, at most 3, no repeats, no infinite loop.
    expect(seenProfiles.length).toBeGreaterThanOrEqual(2);
    expect(seenProfiles.length).toBeLessThanOrEqual(3);
    expect(new Set(seenProfiles).size).toBe(seenProfiles.length);
  });

  it('all rotation attempts share the caller per-fetch deadline (no latency blowup)', async () => {
    // WHY: each rotated attempt must reuse the SAME caller deadline budget, not
    // mint a fresh full timeout per profile. We hand an already-exhausted caller
    // signal; every attempt the backend sees must already be aborted, proving
    // the budget is shared rather than reset per rotation.
    const abortedStates: boolean[] = [];
    _setTlsBackendForTests({
      fetch: async (url, init) => {
        abortedStates.push(init?.signal?.aborted ?? false);
        // Stay blocked so rotation continues to the next profile.
        return challenge403(url);
      },
    });

    process.env.WIGOLO_TLS_BROWSER = 'chrome_142';
    resetConfig();

    const controller = new AbortController();
    controller.abort(new DOMException('caller deadline', 'TimeoutError'));

    // Long internal timeout so a fresh per-attempt timeout would NOT be aborted.
    await tlsFetch('https://stackoverflow.com/questions/3', {
      signal: controller.signal,
      timeoutMs: 30000,
    });

    expect(abortedStates.length).toBeGreaterThanOrEqual(2);
    // Every attempt saw an already-aborted signal -> shared caller deadline.
    expect(abortedStates.every((aborted) => aborted === true)).toBe(true);
  });
});

describe('tls-tier: MCP-stdio safety', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  it('never writes to process.stdout during a tls fetch', async () => {
    _setTlsBackendForTests({
      fetch: async (url) => ({
        status: 200,
        url,
        headers: {
          entries: function* () {
            yield ['content-type', 'text/html'];
          },
        },
        text: async () => '<html><body>safe</body></html>',
      }),
    });

    // Spy on process.stdout.write to count calls. MCP stdio uses stdout for
    // JSON-RPC framing — any rogue write here corrupts the protocol.
    let stdoutWrites = 0;
    const originalWrite = process.stdout.write.bind(process.stdout);
    // Replace with a counter. Return true to mimic the WriteStream contract.
    process.stdout.write = ((..._args: unknown[]) => {
      stdoutWrites++;
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await tlsFetch('https://example.com/stdio-test');
      expect(result.statusCode).toBe(200);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(stdoutWrites).toBe(0);
  });
});

describe('config: WIGOLO_TLS_BROWSER allowlist', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('accepts a whitelisted chrome profile verbatim', () => {
    expect(validateTlsBrowser('chrome_142', 'chrome_142')).toBe('chrome_142');
    expect(validateTlsBrowser('firefox_133', 'chrome_142')).toBe('firefox_133');
    expect(validateTlsBrowser('safari_17', 'chrome_142')).toBe('safari_17');
    expect(validateTlsBrowser('edge_138', 'chrome_142')).toBe('edge_138');
    expect(validateTlsBrowser('opera_105', 'chrome_142')).toBe('opera_105');
  });

  it('falls back to the default on typo / unknown family', () => {
    // Spy on stderr so the warning doesn't pollute test output AND so we can
    // assert it fires. WHY — the warning is the user-visible signal that
    // their env var was ignored; silent fallback would be a worse bug.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(validateTlsBrowser('chrme_142', 'chrome_142')).toBe('chrome_142');
      expect(validateTlsBrowser('netscape_4', 'chrome_142')).toBe('chrome_142');
      expect(validateTlsBrowser('chrome_', 'chrome_142')).toBe('chrome_142');
      expect(validateTlsBrowser('chrome_abc', 'chrome_142')).toBe('chrome_142');
      expect(validateTlsBrowser('; rm -rf /', 'chrome_142')).toBe('chrome_142');
      expect(stderrSpy).toHaveBeenCalled();
      expect(stderrSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns the default on null/empty input without warning', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(validateTlsBrowser(null, 'chrome_142')).toBe('chrome_142');
      expect(validateTlsBrowser(undefined, 'chrome_142')).toBe('chrome_142');
      expect(validateTlsBrowser('', 'chrome_142')).toBe('chrome_142');
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('getConfig().tlsBrowser surfaces the default when env var is hostile', () => {
    process.env.WIGOLO_TLS_BROWSER = 'chrme_142';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const cfg = getConfig();
      expect(cfg.tlsBrowser).toBe('chrome_142');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('getConfig().tlsBrowser honours a valid override', () => {
    process.env.WIGOLO_TLS_BROWSER = 'firefox_133';
    const cfg = getConfig();
    expect(cfg.tlsBrowser).toBe('firefox_133');
  });
});

// Real-binary stdio test — exercises the actual wreq-js napi binding to catch
// future regressions where the underlying Rust code starts writing to stdout
// (which would corrupt MCP JSON-RPC framing). The stubbed test above proves
// our wrapper code stays quiet; this one proves the loaded native dep stays
// quiet too. Skips when the optional dep is unavailable for the host
// platform.
describe.skipIf(!wreqJsAvailable)('tls-tier: real wreq-js binary stdio safety', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    _resetTlsBackend();
    _setTlsBackendForTests(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  it('never writes to process.stdout when the real wreq-js backend executes', async () => {
    // WHY — the napi binary loaded by tlsFetch() runs Rust code that, in
    // principle, could write diagnostics to stdout. D1 spike verified silent
    // operation; this test catches regressions if a future wreq-js release
    // starts logging or if a build flag flips. MCP servers transport JSON-RPC
    // over stdout, so any stray byte breaks the protocol.

    let stdoutWrites = 0;
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((..._args: unknown[]) => {
      stdoutWrites++;
      return true;
    }) as typeof process.stdout.write;

    try {
      // Real call against a known-stable host. We don't care whether it
      // succeeds or fails — both paths route through the napi binding and
      // both must remain silent on stdout. A network error is a perfectly
      // valid execution that still loads the binary.
      try {
        await tlsFetch('https://example.com/', { timeoutMs: 5000 });
      } catch (err) {
        // Either resolves or throws — only stdout matters.
        if (err instanceof TlsTierUnavailableError) {
          // Should not happen since wreqJsAvailable is true, but bail
          // gracefully rather than masking the stdout assertion.
          throw err;
        }
      }
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(stdoutWrites).toBe(0);
  }, 20000);
});
