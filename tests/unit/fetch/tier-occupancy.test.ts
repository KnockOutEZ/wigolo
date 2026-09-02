import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyFetchOutcome,
  readTierOccupancy,
  bumpTierOccupancy,
  markSubstrateServed,
  recordFetchOutcome,
  formatTierOccupancyLines,
  tierOccupancyUsed,
} from '../../../src/fetch/tier-occupancy.js';
import type { RawFetchResult, StageError } from '../../../src/types.js';

/**
 * D-S10-4's instrument. These counters exist to answer ONE question — is the browser rung
 * actually busy on hosts that cannot reach the desktop rung — and the answer decides whether
 * D10(b)'s companion path gets built at all. A counter that miscounts here does not produce a
 * wrong number, it produces a wrong DECISION, so the mapping from a terminal fetch result to a
 * counter is asserted case by case rather than in aggregate.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-occupancy-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function raw(method: RawFetchResult['method']): RawFetchResult {
  return {
    url: 'https://example.test/',
    finalUrl: 'https://example.test/',
    html: '<html></html>',
    contentType: 'text/html',
    statusCode: 200,
    method,
    headers: {},
  };
}

function stage(error: string): StageError {
  return { error, error_reason: 'r', stage: 'fetch' } as StageError;
}

describe('classifyFetchOutcome — the rungs', () => {
  it('counts a plain HTTP result at the HTTP rung', () => {
    expect(classifyFetchOutcome(raw('http'))).toBe('http');
  });

  it('counts a TLS-impersonation result at its own rung, not at HTTP', () => {
    // WHY separately: the TLS rung is the one that would disappear if wreq-js were dropped, and
    // folding it into HTTP would price that decision at zero.
    expect(classifyFetchOutcome(raw('tls-impersonation'))).toBe('tls');
  });

  it('counts a browser result at the browser rung', () => {
    expect(classifyFetchOutcome(raw('browser'))).toBe('browser');
  });

  it('counts a page served by the attended session at the substrate rung, NOT the browser rung', () => {
    // WHY this is the sharpest case in the file: companion-bridge.ts deliberately reports
    // `method: 'browser'` because for every downstream consumer that is what the bytes are. If
    // the recorder trusted `method` alone, every substrate serve would be logged as ordinary
    // browser occupancy — and D10(b)'s whole question is the difference between those two.
    const bridged = markSubstrateServed(raw('browser'));
    expect(classifyFetchOutcome(bridged)).toBe('substrate');
  });

  it('does not mark an unrelated result as substrate-served', () => {
    // Control for the case above: the mark must be per-result, not a mode the module falls into.
    markSubstrateServed(raw('browser'));
    expect(classifyFetchOutcome(raw('browser'))).toBe('browser');
  });
});

describe('classifyFetchOutcome — what is deliberately NOT a rung', () => {
  it('records nothing for a navigation the exfil guard refused', () => {
    // The guard runs before ANY fetcher, so no rung was occupied. Counting it would inflate the
    // denominator with requests that never left the process.
    expect(classifyFetchOutcome(stage('navigation_blocked'))).toBeNull();
  });

  it('records nothing for the Reddit API escape hatch', () => {
    // An origin-specific credentialed path, not a rung on the ladder. Counting it as HTTP would
    // credit the HTTP rung with pages it demonstrably cannot fetch.
    expect(classifyFetchOutcome(raw('reddit-api'))).toBeNull();
  });

  it('records nothing for a browser transport failure', () => {
    // A fault, not an occupancy fact. D10(b) is being sized on demand, and mixing flakiness into
    // the demand number is how a rung comes to look busier than the work justifies.
    expect(classifyFetchOutcome(stage('playwright_fetch_failed'))).toBeNull();
  });
});

describe('classifyFetchOutcome — unmet demand', () => {
  it('counts a terminal challenge block as unmet demand, not as browser occupancy', () => {
    expect(classifyFetchOutcome(stage('blocked_by_challenge'))).toBe('blocked');
  });

  it('counts an unavailable browser engine as demand this host could not supply', () => {
    // THE number that makes the D10(b) case if it makes one: the ladder wanted the browser rung
    // and the machine could not produce it.
    expect(classifyFetchOutcome(stage('browser_engine_unavailable'))).toBe('browserUnavailable');
  });

  it('counts a missing browser install the same way, since for sizing they are the same fact', () => {
    expect(classifyFetchOutcome(stage('playwright_not_installed'))).toBe('browserUnavailable');
  });
});

describe('the counter file', () => {
  it('keeps each tier’s counts separate, so a no-display total is never read off a desktop one', () => {
    // WHY keyed by tier: the question is browser-rung occupancy ON A NO-DISPLAY HOST. A flat
    // total cannot answer it, and it would also conflate the before and after of S10-d's tier
    // flip on any machine whose tier changes underneath these counters.
    bumpTierOccupancy('no-display', 'browser', dataDir);
    bumpTierOccupancy('no-display', 'browser', dataDir);
    bumpTierOccupancy('desktop', 'http', dataDir);

    const occ = readTierOccupancy(dataDir);
    expect(occ['no-display'].browser).toBe(2);
    expect(occ.desktop.browser).toBe(0);
    expect(occ.desktop.http).toBe(1);
    expect(occ['no-display'].http).toBe(0);
  });

  it('returns zeroes when no counter file exists yet', () => {
    const occ = readTierOccupancy(dataDir);
    expect(tierOccupancyUsed(occ)).toBe(false);
    expect(occ.desktop.http).toBe(0);
  });

  it('returns zeroes rather than throwing on a corrupt or foreign-version file', () => {
    // Instrumentation is never load-bearing: a hand-edited or half-written file must degrade to
    // "no data", never to a crash on the fetch path that reads it.
    writeFileSync(join(dataDir, 'tier-occupancy.json'), '{ not json');
    expect(readTierOccupancy(dataDir).desktop.http).toBe(0);
    writeFileSync(join(dataDir, 'tier-occupancy.json'), JSON.stringify({ v: 99, tiers: { desktop: { http: 5 } } }));
    expect(readTierOccupancy(dataDir).desktop.http).toBe(0);
  });

  it('ignores negative, non-finite and non-numeric counts instead of propagating them', () => {
    writeFileSync(
      join(dataDir, 'tier-occupancy.json'),
      JSON.stringify({ v: 1, tiers: { desktop: { http: -4, tls: 'nine', browser: 3.7 } } }),
    );
    const occ = readTierOccupancy(dataDir);
    expect(occ.desktop.http).toBe(0);
    expect(occ.desktop.tls).toBe(0);
    expect(occ.desktop.browser).toBe(3);
  });

  it('writes aggregate integers only — no origin, URL or timestamp reaches the file', () => {
    // WHY asserted over the written BYTES rather than over the type: the F5 reporting rule
    // refuses to disclose browsing history, and a per-origin breakdown is browsing history.
    // Knowing WHICH sites drove the browser rung is not needed to size the rung.
    recordFetchOutcome(raw('browser'), { tier: 'no-display', dataDir });
    const body = readFileSync(join(dataDir, 'tier-occupancy.json'), 'utf-8');
    expect(body).not.toContain('example.test');
    expect(body).not.toContain('://');
    expect(JSON.parse(body)).toEqual({
      v: 1,
      tiers: {
        desktop: { http: 0, tls: 0, browser: 0, substrate: 0, browserUnavailable: 0, blocked: 0 },
        browser: { http: 0, tls: 0, browser: 0, substrate: 0, browserUnavailable: 0, blocked: 0 },
        'no-display': { http: 0, tls: 0, browser: 1, substrate: 0, browserUnavailable: 0, blocked: 0 },
      },
    });
  });

  it('swallows a write failure rather than failing the fetch that triggered it', () => {
    // WHY: this is the D10(a) discipline restated. A read-only data dir is a real deployment
    // (a container with a mounted config), and an instrument that turns it into a fetch failure
    // is worse than no instrument.
    const locked = join(dataDir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const nested = join(locked, 'nested');
      expect(() => bumpTierOccupancy('desktop', 'http', nested)).not.toThrow();
      // Non-vacuous wherever mode bits are actually enforced: prove the write was REFUSED,
      // rather than the counter quietly succeeding and `not.toThrow()` passing for free.
      // win32 has no POSIX perms and root bypasses them outright (containers often run as
      // root), so there the no-throw contract above is the whole of what is under test —
      // asserting the refusal unconditionally would red on Windows only, which is the one
      // platform this suite cannot see locally.
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        expect(existsSync(join(nested, 'tier-occupancy.json'))).toBe(false);
      }
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('records nothing at all for an outcome that maps to no rung', () => {
    recordFetchOutcome(stage('navigation_blocked'), { tier: 'no-display', dataDir });
    expect(tierOccupancyUsed(readTierOccupancy(dataDir))).toBe(false);
  });
});

describe('formatTierOccupancyLines', () => {
  it('says so plainly when nothing has been fetched yet', () => {
    expect(formatTierOccupancyLines(readTierOccupancy(dataDir))).toEqual([
      '  No fetches recorded yet on this machine.',
    ]);
  });

  it('prints only the tiers this machine has actually recorded under', () => {
    // A desktop that has always been a desktop should not be shown two empty rows inviting it to
    // wonder what it did wrong.
    bumpTierOccupancy('no-display', 'browser', dataDir);
    const lines = formatTierOccupancyLines(readTierOccupancy(dataDir));
    expect(lines.some((l) => l.includes('no-display tier'))).toBe(true);
    expect(lines.some((l) => l.includes('desktop tier'))).toBe(false);
  });

  it('prints the unmet-demand line only when there is unmet demand to report', () => {
    bumpTierOccupancy('no-display', 'http', dataDir);
    expect(formatTierOccupancyLines(readTierOccupancy(dataDir)).some((l) => l.includes('Unmet'))).toBe(false);
    bumpTierOccupancy('no-display', 'browserUnavailable', dataDir);
    expect(formatTierOccupancyLines(readTierOccupancy(dataDir)).some((l) => l.includes('Unmet'))).toBe(true);
  });

  it('states that the counters are local, every time it prints any', () => {
    // The claim that nothing leaves the machine is only reassuring where it is visible. A user
    // reading a per-rung breakdown is exactly the user wondering who else can see it.
    bumpTierOccupancy('desktop', 'http', dataDir);
    expect(formatTierOccupancyLines(readTierOccupancy(dataDir)).join('\n')).toContain('never sent anywhere');
  });

  it('uses capability language in every rendered line', () => {
    // The CLAUDE.md naming rule, asserted over the RENDERED strings rather than the source: the
    // module's comments legitimately discuss the implementation, and a library name in a comment
    // is not a user-visible defect while the same word in an output line is.
    for (const tier of ['desktop', 'browser', 'no-display'] as const) {
      for (const key of ['http', 'tls', 'browser', 'substrate', 'browserUnavailable', 'blocked'] as const) {
        bumpTierOccupancy(tier, key, dataDir);
      }
    }
    const rendered = formatTierOccupancyLines(readTierOccupancy(dataDir)).join('\n');
    for (const banned of ['Electron', 'Chromium', 'chromium', 'Playwright', 'playwright', 'CDP', 'Puppeteer']) {
      expect(rendered).not.toContain(banned);
    }
  });
});
