import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildBrowserTierDoctorLines, buildTierOccupancyDoctorLines } from '../../../src/cli/doctor.js';
import type { TierOccupancy } from '../../../src/fetch/tier-occupancy.js';
import { formatStatus, type StatusBag } from '../../../src/cli/tui/status-format.js';
import {
  resolveBrowserTier,
  resetBrowserTierAnnouncements,
  NO_DISPLAY_CEILING,
} from '../../../src/fetch/browser-tier.js';

function tierFor(inputs: Parameters<typeof resolveBrowserTier>[0]) {
  resetBrowserTierAnnouncements();
  return resolveBrowserTier({ env: {}, substrateInstalled: () => false, ...inputs });
}

describe('doctor — browser tier section (D-S10-9)', () => {
  it('prints the tier and the reason on the healthy default', () => {
    const lines = buildBrowserTierDoctorLines(tierFor({ platform: 'darwin' }));
    expect(lines.join('\n')).toContain('Resolved:      desktop');
    expect(lines.some((l) => l.startsWith('  Why:'))).toBe(true);
  });

  it('prints the stated ceiling on the no-display tier', () => {
    // WHY: the tier alone is not actionable. Reported without its ceiling, "no-display" reads
    // as a fault to be fixed rather than as physics with a known cost, and the support genre
    // this section exists to prevent is a server user expecting desktop pass rates.
    const lines = buildBrowserTierDoctorLines(tierFor({ platform: 'linux' }));
    const text = lines.join('\n');
    expect(text).toContain('Resolved:      no-display');
    expect(text).toContain(NO_DISPLAY_CEILING);
    expect(text).toMatch(/Remedy:/);
  });

  it('omits the ceiling line entirely on the desktop tier rather than printing an empty one', () => {
    const text = buildBrowserTierDoctorLines(tierFor({ platform: 'darwin' })).join('\n');
    expect(text).not.toMatch(/Ceiling:/);
  });

  it('states the ceiling as four independent signals, not one example', () => {
    // WHY (tracker rule 7): each clause is asserted on its own, so deleting any single one
    // reds. A ceiling summarised by its most memorable clause reads narrower than it is.
    const text = buildBrowserTierDoctorLines(tierFor({ platform: 'linux' })).join('\n');
    expect(text).toMatch(/throwaway profile/i);
    expect(text).toMatch(/fresh fingerprint/i);
    expect(text).toMatch(/automation-launched/i);
    expect(text).toMatch(/datacenter IP/i);
  });

  it('says acquisition is deferred when a substrate is already installed (D13)', () => {
    const text = buildBrowserTierDoctorLines(
      tierFor({ platform: 'darwin', substrateInstalled: () => true }),
    ).join('\n');
    expect(text).toMatch(/Acquisition:\s+deferred/);
  });
});

describe('doctor — tier-occupancy section (D-S10-4)', () => {
  const empty = (): TierOccupancy => ({
    desktop: { http: 0, tls: 0, browser: 0, substrate: 0, browserUnavailable: 0, blocked: 0 },
    browser: { http: 0, tls: 0, browser: 0, substrate: 0, browserUnavailable: 0, blocked: 0 },
    'no-display': { http: 0, tls: 0, browser: 0, substrate: 0, browserUnavailable: 0, blocked: 0 },
  });

  it('heads the counters so they read as occupancy, not as a second tier verdict', () => {
    // The section sits immediately under "Resolved: <tier>". Without a header of its own, a row
    // of six numbers directly beneath a verdict reads as detail OF the verdict.
    expect(buildTierOccupancyDoctorLines(empty())[0]).toBe('  Rungs used:');
  });

  it('reports the no-display browser-rung count that the D10(b) decision turns on', () => {
    // WHY here as well as in the module's own tests: `doctor` is where this number is actually
    // read by a human, and a counter nobody can see cannot inform a decision.
    const occ = empty();
    occ['no-display'].browser = 9;
    occ['no-display'].browserUnavailable = 4;
    const text = buildTierOccupancyDoctorLines(occ).join('\n');
    expect(text).toContain('On the no-display tier:');
    expect(text).toContain('9 by a browser engine');
    expect(text).toContain('4 needed a browser engine this machine could not start');
  });
});

describe('status — browser tier block', () => {
  const base: StatusBag = {
    version: '1.2.3',
    browserTier: { tier: 'desktop', detail: 'a display server is present (DISPLAY is set)', desktopComponent: 'not installed' },
    searxng: 'ready',
    reranker: 'ok',
    embeddings: 'ok',
    cache: { pages: 0, bytes: 0 },
    agents: [],
  };

  it('always renders the tier, even on the healthy default', () => {
    // WHY: the escalation counters below it are hidden until used, deliberately. The tier is
    // not — a machine that resolved to a weaker rung has to find out BEFORE a fetch quietly
    // underperforms, which means it cannot wait for the first fetch to reveal it.
    const out = formatStatus(base);
    expect(out).toContain('Browser tier:');
    expect(out).toContain('Resolved: desktop');
  });

  it('renders the ceiling and the remedy when the rung is weaker', () => {
    const out = formatStatus({
      ...base,
      browserTier: {
        tier: 'no-display',
        detail: 'no display server was found',
        desktopComponent: 'not installed',
        ceiling: NO_DISPLAY_CEILING,
        remedy: 'attach a display session',
      },
    });
    expect(out).toContain(NO_DISPLAY_CEILING);
    expect(out).toContain('attach a display session');
  });

  it('stays silent about rung occupancy until something has been fetched', () => {
    // D-S10-4, following the browserSession precedent directly above it: a block of zeroes
    // printed for every fresh install is the kind of section people learn to skip, and it would
    // be skipped by the time it finally carries the number the D10(b) decision needs.
    expect(formatStatus(base)).not.toContain('Rungs used');
  });

  it('renders the occupancy row for the tier this host resolved to', () => {
    const out = formatStatus({
      ...base,
      rungsUsed: { http: 12, tls: 3, browser: 4, substrate: 0, browserUnavailable: 2, blocked: 1 },
    });
    expect(out).toContain('Rungs used: 12 direct, 3 hardened, 4 browser engine, 0 attended session');
    expect(out).toMatch(/could not start: 2/);
    expect(out).toMatch(/bot-protection challenge: 1/);
    expect(out).toContain('never leave this machine');
  });

  it('omits the unmet-demand lines when there is no unmet demand', () => {
    // WHY separately from the case above: those two lines are the ones a reader will treat as a
    // problem report. Printing "0" for them on a healthy machine manufactures a problem.
    const out = formatStatus({
      ...base,
      rungsUsed: { http: 5, tls: 0, browser: 0, substrate: 0, browserUnavailable: 0, blocked: 0 },
    });
    expect(out).toContain('Rungs used: 5 direct');
    expect(out).not.toMatch(/could not start/);
    expect(out).not.toMatch(/bot-protection challenge/);
  });
});

describe('doctor remedies name commands that exist', () => {
  it('never tells the user to run a warmup flag runWarmup does not read', async () => {
    // WHY (assertion 28): doctor.ts told users to run `wigolo warmup --browser` for months
    // while runWarmup never read the flag. It "worked" only because the browser install was
    // unconditional — a drift that becomes a real break the moment acquisition is gated on a
    // tier. This asserts the property, not the one instance of it.
    // A URL, not a `.pathname` string: on win32 `.pathname` yields `/C:/...` and every fs call
    // rejects it, so the check would fail on exactly one platform.
    const src = (rel: string) => new URL(`../../../src/${rel}`, import.meta.url);
    const doctorSrc = await readFile(src('cli/doctor.ts'), 'utf8');
    const warmupSrc = await readFile(src('cli/warmup.ts'), 'utf8');

    const cited = new Set(
      [...doctorSrc.matchAll(/wigolo warmup ((?:--[a-z-]+ ?)+)/g)]
        .flatMap((m) => m[1].trim().split(/\s+/)),
    );
    expect(cited.size).toBeGreaterThan(0);

    const read = new Set(
      [...warmupSrc.matchAll(/flagSet\.has\('(--[a-z-]+)'\)/g)].map((m) => m[1]),
    );
    const orphans = [...cited].filter((flag) => !read.has(flag));
    expect(orphans).toEqual([]);
  });
});

describe('doctor states what the tier COST and what is still lazy (S10-d)', () => {
  const record = {
    version: '1.2.3',
    executable: 'bin/run',
    path: '/somewhere/substrate/1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    acquiredAt: '2026-08-11T00:00:00.000Z',
    source: 'local-path',
  };

  it('names the installed component and its version when one has been acquired', () => {
    const lines = buildBrowserTierDoctorLines(tierFor({ platform: 'darwin' }), record);
    expect(lines.join('\n')).toMatch(/Desktop comp\..*installed \(version 1\.2\.3\)/);
  });

  it('tells a desktop machine with no component how to get one', () => {
    // WHY: "acquired and ready" and "never acquired, will download on first need" are
    // indistinguishable from outside, and only one of them has an action attached. A tier line
    // that reports the rung but not the component leaves the user unable to tell which they are in.
    const lines = buildBrowserTierDoctorLines(tierFor({ platform: 'darwin' }), null);
    expect(lines.join('\n')).toMatch(/Desktop comp\..*not installed/);
    expect(lines.join('\n')).toMatch(/wigolo warmup/);
  });

  it('says plainly that a no-display host spent nothing on a component', () => {
    // WHY: D-S10-5's claim is about BYTES, and a user on a server should be able to read that
    // they were not charged for a component they cannot run — that is the "CI pulls 250 MB"
    // complaint the brief names, answered where the user actually looks.
    const lines = buildBrowserTierDoctorLines(tierFor({ platform: 'linux', env: {} }), null);
    expect(lines.join('\n')).toMatch(/no bytes acquired for it/);
  });

  it('still states the no-display ceiling alongside the component line', () => {
    // WHY: the component row must not push the ceiling out. A rung reported without its ceiling
    // is how a server user comes to expect desktop pass rates.
    const lines = buildBrowserTierDoctorLines(tierFor({ platform: 'linux', env: {} }), null);
    expect(lines.join('\n')).toContain(NO_DISPLAY_CEILING);
  });

  it('keeps the component lines free of implementation and product names', () => {
    // WHY: these lines are user-facing, so the capability-language rule applies to them exactly
    // as it does to the tier strings the resolver renders.
    const banned = /electron|chromium|playwright|\bCDP\b|puppeteer/i;
    for (const substrate of [record, null]) {
      for (const inputs of [{ platform: 'darwin' as const }, { platform: 'linux' as const, env: {} }]) {
        for (const line of buildBrowserTierDoctorLines(tierFor(inputs), substrate)) {
          expect(line, line).not.toMatch(banned);
        }
      }
    }
  });
});

describe('status reports the component too (S10-d)', () => {
  const bag = (desktopComponent: string): StatusBag => ({
    version: '0.0.0',
    browserTier: { tier: 'desktop', detail: 'a display session', desktopComponent },
    searxng: 'ready',
    reranker: 'ok',
    embeddings: 'ok',
    cache: { pages: 0, bytes: 0 },
    agents: [],
  });

  it('renders the component state unconditionally', () => {
    // WHY UNCONDITIONAL, unlike the counter blocks: "not installed" is the informative state
    // here. A section hidden until it has something to say would hide exactly the case a user
    // needs to see.
    expect(formatStatus(bag('not installed'))).toMatch(/Desktop component: not installed/);
    expect(formatStatus(bag('installed (version 9.9.9)'))).toMatch(/Desktop component: installed \(version 9\.9\.9\)/);
  });
});
