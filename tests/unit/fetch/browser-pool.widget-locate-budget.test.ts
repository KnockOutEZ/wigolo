import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import {
  WIDGET_LOCATE_TIMEOUT_MS,
  WIDGET_LOCATE_SELECTOR_COUNT,
} from '../../../src/fetch/browser-pool.js';

/**
 * The auto-pass rung locates the challenge widget by probing a list of
 * selectors. A miss must cost MILLISECONDS, not Playwright's 30s default
 * actionability wait — measured live, an unbounded probe turned a 15s
 * blocked-by-challenge fetch into a 226s one, because every selector in the
 * list paid the full default timeout before the rung could give up.
 *
 * The whole probe budget is what matters to a caller, so assert on it directly.
 */
describe('challenge-widget locate budget', () => {
  beforeEach(() => resetConfig());
  afterEach(() => resetConfig());

  it('bounds a full all-selectors-miss probe well under a single fetch budget', () => {
    const worstCaseMs = WIDGET_LOCATE_TIMEOUT_MS * WIDGET_LOCATE_SELECTOR_COUNT;
    // A total miss must stay inside a couple of seconds. Playwright's 30s
    // default across this many selectors would be minutes.
    expect(worstCaseMs).toBeLessThanOrEqual(5_000);
  });

  it('uses a per-selector timeout far below the browser-engine default (30s)', () => {
    expect(WIDGET_LOCATE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WIDGET_LOCATE_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  });

  it('passes that explicit timeout to EVERY boundingBox probe (never the default)', async () => {
    const { MultiBrowserPool } = await import('../../../src/fetch/browser-pool.js');
    const seenTimeouts: Array<unknown> = [];
    const boundingBox = vi.fn(async (opts?: { timeout?: number }) => {
      seenTimeouts.push(opts?.timeout);
      return null; // every selector misses — the worst case
    });
    const page = {
      locator: vi.fn(() => ({ first: () => ({ boundingBox }) })),
    };

    const pool = new MultiBrowserPool();
    // locateChallengeWidget is private; reach it through the class the same way
    // the ladder does, without standing up a browser.
    const locate = (
      pool as unknown as {
        locateChallengeWidget: (p: unknown) => Promise<{ x: number; y: number } | null>;
      }
    ).locateChallengeWidget.bind(pool);

    const result = await locate(page);

    expect(result).toBeNull();
    expect(seenTimeouts.length).toBe(WIDGET_LOCATE_SELECTOR_COUNT);
    // Not one probe may fall through to the engine default.
    expect(seenTimeouts.every((t) => t === WIDGET_LOCATE_TIMEOUT_MS)).toBe(true);
    await pool.shutdown();
  });
});
