import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveAuthenticChrome,
  cdpDirectFetch,
  _setCdpDirectFetchDepsForTests,
  _setProcessKillForTests,
  _resetDeclineLatchForTests,
  type CdpDirectFetchDeps,
  type ChromeResolution,
} from '../../../src/fetch/cdp-direct.js';
import { resetConfig } from '../../../src/config.js';

/**
 * WHY this file exists.
 *
 * `WIGOLO_CDP_DIRECT=on` shipped as a SILENT NO-OP on every default install:
 * the resolver short-circuited to `null` whenever `browserChannel === 'chromium'`,
 * which is the DEFAULT, and it said so only at `debug`. The rung had therefore
 * never executed for any default user, and nobody could tell — it voided a whole
 * round of live measurements that read "byte-identical results" as a null result
 * about handshakes when in fact the rung never ran.
 *
 * So two properties are load-bearing here and must stay tested:
 *   1. REACHABILITY — an explicit opt-in makes the rung ATTEMPT resolution.
 *   2. VISIBILITY   — every decline is emitted at `warn` with a reason AND a
 *      remedy. A rung that cannot run must say why; silence is the defect.
 */

// The env knobs these tests drive. Saved/restored so nothing leaks across files.
const ENV_KEYS = ['WIGOLO_CDP_DIRECT', 'WIGOLO_BROWSER_CHANNEL', 'WIGOLO_CHROME_PATH', 'CHROME_PATH'] as const;
const saved: Record<string, string | undefined> = {};

function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  resetConfig();
}

/** Captures every stderr log line the rung emits, parsed back into records. */
function captureLogs(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  return { lines: () => written, restore: () => spy.mockRestore() };
}

describe('cdp-direct reachability — an explicit opt-in must ATTEMPT resolution', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    resetConfig();
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const orig = saved[key];
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
    resetConfig();
    _setCdpDirectFetchDepsForTests(undefined);
    _setProcessKillForTests(undefined);
    vi.restoreAllMocks();
  });

  // THE test this slice exists for. With `WIGOLO_CDP_DIRECT=on` and NO other
  // knob, resolution must actually be tried: candidate executables get probed.
  // Before the fix this returned `{ path: null, reason: 'chromium-pinned' }`
  // without touching the filesystem, because `browserChannel` defaults to
  // 'chromium' — so the rung was dead code on every default install.
  it('probes for an authentic browser on a DEFAULT config with WIGOLO_CDP_DIRECT=on', () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'on' });
    const probed: string[] = [];
    const res = resolveAuthenticChrome({
      exists: (path) => {
        probed.push(path);
        return false;
      },
    });

    expect(probed.length).toBeGreaterThan(0);
    expect(res.probed).toEqual(probed);
    expect(res.reason).not.toBe('chromium-pinned');
  });

  // `auto` is the mode the hardcore preset sets and is equally an opt-in from
  // the 'off' default, so it must be reachable on a default config too —
  // otherwise the same trap survives one env value to the left.
  it('probes on a DEFAULT config with WIGOLO_CDP_DIRECT=auto', () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'auto' });
    const res = resolveAuthenticChrome({ exists: () => false });
    expect(res.probed.length).toBeGreaterThan(0);
    expect(res.reason).toBe('no-authentic-browser');
  });

  // NEGATIVE — the override must NOT fire for an operator who never opted in.
  // With the rung off, the bundled-engine pin still wins and nothing is probed.
  // (In production `cdpDirect: 'off'` means the rung is never consulted at all;
  // this pins the resolver's own contract so the override stays TIED to intent.)
  it('does NOT override the bundled-engine pin when the rung was not opted into', () => {
    setEnv({});
    const res = resolveAuthenticChrome({ exists: () => true });
    expect(res.path).toBeNull();
    expect(res.reason).toBe('chromium-pinned');
    expect(res.probed).toEqual([]);
  });

  // An explicit opt-in outranks an EXPLICIT bundled-engine pin, and says so.
  // Precedence: the knob specific to this rung beats the general channel knob,
  // whose own documented scope is the stealth path — not this rung.
  it('reports the pin as overridden when both knobs were set explicitly', () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'on', WIGOLO_BROWSER_CHANNEL: 'chromium' });
    const res = resolveAuthenticChrome({ exists: () => false });
    expect(res.probed.length).toBeGreaterThan(0);
    expect(res.pinOverridden).toBe(true);
  });

  // NEGATIVE — a `chrome`/`auto` channel is not an override of anything.
  it('does not report an override when the channel does not pin the bundled engine', () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'on', WIGOLO_BROWSER_CHANNEL: 'chrome' });
    const res = resolveAuthenticChrome({ exists: () => false });
    expect(res.pinOverridden).toBe(false);
  });

  // Spoof nothing: an absent browser resolves to null with an honest reason.
  // Declining is CORRECT behaviour here, not a failure — what is forbidden is
  // inventing a path or claiming a Chrome-ish identity built out of chromium.
  it('returns a null path with an honest reason when no browser is installed', () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'on' });
    const res = resolveAuthenticChrome({ exists: () => false });
    expect(res.path).toBeNull();
    expect(res.reason).toBe('no-authentic-browser');
  });

  // The explicit path override is honoured and counted as a probe.
  it('honours WIGOLO_CHROME_PATH and records it as probed', () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'on', WIGOLO_CHROME_PATH: '/opt/my/chrome' });
    const res = resolveAuthenticChrome({ exists: (p) => p === '/opt/my/chrome' });
    expect(res.path).toBe('/opt/my/chrome');
    expect(res.probed).toContain('/opt/my/chrome');
  });
});

describe('cdp-direct decline visibility — a rung that cannot run must SAY SO', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    resetConfig();
    // Static decline causes latch per process; clear it so each case observes a
    // fresh one rather than inheriting a prior test's first-warn.
    _resetDeclineLatchForTests();
    _setProcessKillForTests(() => {});
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const orig = saved[key];
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
    resetConfig();
    _setCdpDirectFetchDepsForTests(undefined);
    _setProcessKillForTests(undefined);
    vi.restoreAllMocks();
  });

  function declineDeps(resolution: ChromeResolution): CdpDirectFetchDeps {
    return {
      resolveChrome: () => resolution,
      spawn: (() => {
        throw new Error('must not spawn when resolution declined');
      }) as unknown as CdpDirectFetchDeps['spawn'],
      isReachable: async () => true,
      mkdtemp: async (prefix: string) => `${prefix}fake`,
      rm: async () => {},
      connectTransport: async () => null,
    };
  }

  // The probe that the decline path is NOT silently swallowed: `warn` is above
  // the default log level, so an operator who set the knob sees the line without
  // turning on debug logging — which is precisely what did not happen before.
  it('warns with a reason AND a remedy when no authentic browser resolves', async () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'on' });
    _setCdpDirectFetchDepsForTests(
      declineDeps({ path: null, reason: 'no-authentic-browser', probed: ['/nope'], pinOverridden: true }),
    );
    const cap = captureLogs();
    try {
      const result = await cdpDirectFetch('https://example.com', {});
      expect(result).toBeNull();
      const warns = cap.lines().filter((l) => l.includes('WARN') || l.includes('"level":"warn"'));
      expect(warns.length).toBeGreaterThan(0);
      const joined = warns.join('\n');
      expect(joined).toContain('no-authentic-browser');
      // The remedy must name something the operator can actually do.
      expect(joined).toMatch(/WIGOLO_CHROME_PATH/);
    } finally {
      cap.restore();
    }
  });

  it('warns when the control endpoint never becomes reachable', async () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'on' });
    const child = {
      pid: 4242,
      on: vi.fn(),
      kill: vi.fn(),
      exitCode: 0,
      signalCode: null,
    };
    _setCdpDirectFetchDepsForTests({
      resolveChrome: () => ({ path: '/fake/chrome', probed: ['/fake/chrome'], pinOverridden: true }),
      spawn: (() => child) as unknown as CdpDirectFetchDeps['spawn'],
      isReachable: async () => false,
      mkdtemp: async (prefix: string) => `${prefix}fake`,
      rm: async () => {},
      connectTransport: async () => null,
    });
    const cap = captureLogs();
    try {
      const result = await cdpDirectFetch('https://example.com', { timeoutMs: 60 });
      expect(result).toBeNull();
      const joined = cap.lines().filter((l) => l.includes('WARN') || l.includes('"level":"warn"')).join('\n');
      expect(joined).toContain('control-endpoint-unreachable');
    } finally {
      cap.restore();
    }
  });

  // An aborted fetch is the CALLER cancelling, not the rung declining, so it
  // must stay off the warn channel — otherwise every cancelled fetch cries wolf
  // and the signal this slice adds gets drowned in noise.
  it('does NOT warn when the caller aborted before the rung started', async () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'on' });
    const cap = captureLogs();
    try {
      const result = await cdpDirectFetch('https://example.com', { signal: AbortSignal.abort() });
      expect(result).toBeNull();
      const warns = cap.lines().filter((l) => l.includes('WARN') || l.includes('"level":"warn"'));
      expect(warns).toEqual([]);
    } finally {
      cap.restore();
    }
  });
});
