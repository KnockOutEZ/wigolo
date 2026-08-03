import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  cdpDirectFetch,
  _setCdpDirectFetchDepsForTests,
  _setProcessKillForTests,
  _resetDeclineLatchForTests,
  type CdpDirectFetchDeps,
  type CdpTransport,
  type CdpSend,
} from '../../../src/fetch/cdp-direct.js';
import { resetConfig } from '../../../src/config.js';
import type { LookupAll } from '../../../src/watch/ssrf.js';

/**
 * WHY this file exists.
 *
 * The reachability fix promoted this rung's declines onto `warn`, which is ABOVE
 * the default log level. That makes two properties safety-relevant that were not
 * before:
 *
 *   1. NO CREDENTIAL EVER REACHES THE LOG. The whole point of the new channel is
 *      that an operator pastes it into a bug report. A fetch of
 *      `https://svc:pw@host/x?token=…` must not put the secret there.
 *   2. A REPEATING HOST FACT MUST NOT BURY A VARYING ONE. Static causes (no
 *      browser installed, an unusable proxy, an absent optional dependency) are
 *      identical on every fetch; unlatched, a 200-page crawl emits 200 copies and
 *      the per-target causes become unfindable — the exact opposite of the point.
 */

// A secret that must never appear in any log line, in either carrier shape.
const USERINFO_URL = 'https://svc:s3cr3tP4ss@internal.example/report';
const TOKEN_URL = 'https://ok.example/report?token=eyJhbGciOiJIUzI1NiJ9.SUPERSECRETPAYLOAD&x=1';
const SECRETS = ['s3cr3tP4ss', 'SUPERSECRETPAYLOAD', 'eyJhbGciOiJIUzI1NiJ9', 'token='];

const PUBLIC_LOOKUP: LookupAll = ((_hostname, _options, callback) => {
  callback(null, [{ address: '93.184.216.34', family: 4 }]);
}) as LookupAll;

const REAL_HTML =
  '<html><head><title>Report</title></head><body><h1>Report</h1>' +
  '<p>An ordinary paragraph of ordinary prose at ordinary length so the challenge classifier reads real content. </p>'.repeat(
    10,
  ) +
  '</body></html>';

class FakeChild extends EventEmitter {
  pid = 5150;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(signal?: NodeJS.Signals | number): boolean {
    setImmediate(() => this.emit('exit', 0, signal ?? null));
    return true;
  }
}

function servingTransport(): CdpTransport {
  const send: CdpSend = async (method, params) => {
    switch (method) {
      case 'Page.createIsolatedWorld':
        return { executionContextId: 11 };
      case 'Runtime.evaluate': {
        const expr = String(params?.expression ?? '');
        // The landing read must return a URL that still carries the secret, so a
        // leak through `finalUrl` is caught rather than assumed absent.
        if (expr.includes('location')) return { result: { type: 'string', value: USERINFO_URL } };
        return { result: { type: 'string', value: REAL_HTML } };
      }
      case 'Page.navigate':
        return { frameId: 'f1' };
      default:
        return {};
    }
  };
  return { send, close: async () => {} };
}

/** Deps that drive the rung all the way to served content. */
function servingDeps(): CdpDirectFetchDeps {
  return {
    resolveChrome: () => ({ path: '/fake/chrome', probed: ['/fake/chrome'], pinOverridden: false }),
    spawn: (() => new FakeChild()) as unknown as CdpDirectFetchDeps['spawn'],
    isReachable: async () => true,
    mkdtemp: async (prefix: string) => `${prefix}fake`,
    rm: async () => {},
    connectTransport: async () => servingTransport(),
  };
}

/** Deps that decline at resolution with a given reason. */
function decliningDeps(reason: 'no-authentic-browser'): CdpDirectFetchDeps {
  return {
    ...servingDeps(),
    resolveChrome: () => ({ path: null, reason, probed: [], pinOverridden: false }),
  };
}

/** Deps that decline AFTER launch — the control endpoint never comes up. */
function transientDeclineDeps(): CdpDirectFetchDeps {
  return {
    ...servingDeps(),
    isReachable: async () => false,
  };
}

function captureLogs(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return { lines: () => written, restore: () => spy.mockRestore() };
}

function warnLines(lines: string[]): string[] {
  return lines.filter((l) => l.includes('WARN') || l.includes('"level":"warn"'));
}

describe('cdp-direct log hygiene — no credential reaches the default-visible log', () => {
  beforeEach(() => {
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();
    _resetDeclineLatchForTests();
    _setProcessKillForTests(() => {});
  });
  afterEach(() => {
    delete process.env.WIGOLO_CDP_DIRECT;
    resetConfig();
    _resetDeclineLatchForTests();
    _setCdpDirectFetchDepsForTests(undefined);
    _setProcessKillForTests(undefined);
    vi.restoreAllMocks();
  });

  // The SUCCESS path: `rung engaged` + `rung produced content` both log the
  // target at info, and the post-redirect guard reads a landing URL that also
  // carries the secret. All three must be redacted.
  it('leaks nothing from a userinfo-bearing URL on the path that SERVES content', async () => {
    _setCdpDirectFetchDepsForTests(servingDeps());
    const cap = captureLogs();
    try {
      const result = await cdpDirectFetch(USERINFO_URL, { timeoutMs: 20_000, lookup: PUBLIC_LOOKUP });
      expect(result).not.toBeNull();
      const all = cap.lines().join('\n');
      // Proof the assertion is not vacuous: the rung really did log about it.
      expect(all).toContain('cdp-direct rung produced content');
      for (const secret of SECRETS) expect(all).not.toContain(secret);
      // …while still identifying the endpoint, which is the point of redacting
      // rather than omitting.
      expect(all).toContain('internal.example/report');
    } finally {
      cap.restore();
    }
  });

  it('leaks nothing from a query-token URL on the path that SERVES content', async () => {
    _setCdpDirectFetchDepsForTests(servingDeps());
    const cap = captureLogs();
    try {
      await cdpDirectFetch(TOKEN_URL, { timeoutMs: 20_000, lookup: PUBLIC_LOOKUP });
      const all = cap.lines().join('\n');
      expect(all).toContain('cdp-direct rung engaged');
      for (const secret of SECRETS) expect(all).not.toContain(secret);
      expect(all).toContain('ok.example/report');
    } finally {
      cap.restore();
    }
  });

  // The DECLINE path — the channel this PR promoted to default-visible, and the
  // one an operator is most likely to paste into an issue.
  it('leaks nothing from a userinfo-bearing URL on the DECLINE path', async () => {
    _setCdpDirectFetchDepsForTests(decliningDeps('no-authentic-browser'));
    const cap = captureLogs();
    try {
      const result = await cdpDirectFetch(USERINFO_URL, { lookup: PUBLIC_LOOKUP });
      expect(result).toBeNull();
      const warns = warnLines(cap.lines());
      expect(warns.length).toBeGreaterThan(0);
      const all = warns.join('\n');
      for (const secret of SECRETS) expect(all).not.toContain(secret);
    } finally {
      cap.restore();
    }
  });

  it('leaks nothing from a query-token URL on the DECLINE path', async () => {
    _setCdpDirectFetchDepsForTests(decliningDeps('no-authentic-browser'));
    const cap = captureLogs();
    try {
      await cdpDirectFetch(TOKEN_URL, { lookup: PUBLIC_LOOKUP });
      const all = warnLines(cap.lines()).join('\n');
      expect(all).toContain('no-authentic-browser');
      for (const secret of SECRETS) expect(all).not.toContain(secret);
    } finally {
      cap.restore();
    }
  });
});

describe('cdp-direct decline latch — a repeating host fact must not bury a varying one', () => {
  beforeEach(() => {
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();
    _resetDeclineLatchForTests();
    _setProcessKillForTests(() => {});
  });
  afterEach(() => {
    delete process.env.WIGOLO_CDP_DIRECT;
    resetConfig();
    _resetDeclineLatchForTests();
    _setCdpDirectFetchDepsForTests(undefined);
    _setProcessKillForTests(undefined);
    vi.restoreAllMocks();
  });

  // A STATIC cause is a host fact: identical on fetch 1 and fetch 200. Warning
  // 200 times is not 200 units of information, it is one unit plus 199 units of
  // noise sitting on top of the causes that do vary.
  it('warns ONCE for a repeated static cause across many fetches', async () => {
    _setCdpDirectFetchDepsForTests(decliningDeps('no-authentic-browser'));
    const cap = captureLogs();
    try {
      for (let i = 0; i < 5; i += 1) {
        await cdpDirectFetch(`https://host-${i}.example/page`, { lookup: PUBLIC_LOOKUP });
      }
      const warns = warnLines(cap.lines()).filter((l) => l.includes('no-authentic-browser'));
      expect(warns.length).toBe(1);
    } finally {
      cap.restore();
    }
  });

  // NEGATIVE / must-still-fire: a TRANSIENT cause is about THIS target, so its
  // repetition IS the signal. Latching it would recreate the silence this whole
  // change exists to remove.
  it('warns EVERY TIME for a repeated transient cause', async () => {
    _setCdpDirectFetchDepsForTests(transientDeclineDeps());
    const cap = captureLogs();
    try {
      for (let i = 0; i < 3; i += 1) {
        await cdpDirectFetch(`https://host-${i}.example/page`, {
          timeoutMs: 60,
          lookup: PUBLIC_LOOKUP,
        });
      }
      const warns = warnLines(cap.lines()).filter((l) => l.includes('control-endpoint-unreachable'));
      expect(warns.length).toBe(3);
    } finally {
      cap.restore();
    }
  });

  // The latch is per-reason, not global: a static cause being latched must not
  // swallow a different cause that follows it.
  it('latches per reason — a second, different cause still warns', async () => {
    const cap = captureLogs();
    try {
      _setCdpDirectFetchDepsForTests(decliningDeps('no-authentic-browser'));
      await cdpDirectFetch('https://a.example/p', { lookup: PUBLIC_LOOKUP });
      await cdpDirectFetch('https://b.example/p', { lookup: PUBLIC_LOOKUP });
      _setCdpDirectFetchDepsForTests(transientDeclineDeps());
      await cdpDirectFetch('https://c.example/p', { timeoutMs: 60, lookup: PUBLIC_LOOKUP });

      const warns = warnLines(cap.lines());
      expect(warns.filter((l) => l.includes('no-authentic-browser')).length).toBe(1);
      expect(warns.filter((l) => l.includes('control-endpoint-unreachable')).length).toBe(1);
    } finally {
      cap.restore();
    }
  });
});
