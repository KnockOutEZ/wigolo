import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildBrowserTierDoctorLines } from '../../../src/cli/doctor.js';
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

describe('status — browser tier block', () => {
  const base: StatusBag = {
    version: '1.2.3',
    browserTier: { tier: 'desktop', detail: 'a display server is present (DISPLAY is set)' },
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
        ceiling: NO_DISPLAY_CEILING,
        remedy: 'attach a display session',
      },
    });
    expect(out).toContain(NO_DISPLAY_CEILING);
    expect(out).toContain('attach a display session');
  });
});

describe('doctor remedies name commands that exist', () => {
  it('never tells the user to run a warmup flag runWarmup does not read', async () => {
    // WHY (assertion 28): doctor.ts told users to run `wigolo warmup --browser` for months
    // while runWarmup never read the flag. It "worked" only because the browser install was
    // unconditional — a drift that becomes a real break the moment acquisition is gated on a
    // tier. This asserts the property, not the one instance of it.
    const root = new URL('../../../src/', import.meta.url).pathname;
    const doctorSrc = await readFile(`${root}cli/doctor.ts`, 'utf8');
    const warmupSrc = await readFile(`${root}cli/warmup.ts`, 'utf8');

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
