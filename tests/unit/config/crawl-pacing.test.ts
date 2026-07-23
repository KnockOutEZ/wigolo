import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, resetConfig } from '../../../src/config.js';

const keys = [
  'WIGOLO_CRAWL_JITTER_PCT',
  'WIGOLO_CRAWL_COOLDOWN_FACTOR',
  'WIGOLO_CRAWL_COOLDOWN_MAX_MS',
];

describe('crawl pacing config', () => {
  beforeEach(() => resetConfig());
  afterEach(() => {
    keys.forEach((k) => delete process.env[k]);
    resetConfig();
  });

  it('defaults: jitter 0.3, cooldown factor 2, cooldown max 300000ms', () => {
    const c = getConfig();
    expect(c.crawlJitterPct).toBe(0.3);
    expect(c.crawlCooldownFactor).toBe(2);
    expect(c.crawlCooldownMaxMs).toBe(300000);
  });

  it('honors env overrides', () => {
    process.env.WIGOLO_CRAWL_JITTER_PCT = '0.5';
    process.env.WIGOLO_CRAWL_COOLDOWN_FACTOR = '3';
    process.env.WIGOLO_CRAWL_COOLDOWN_MAX_MS = '60000';
    resetConfig();
    const c = getConfig();
    expect(c.crawlJitterPct).toBe(0.5);
    expect(c.crawlCooldownFactor).toBe(3);
    expect(c.crawlCooldownMaxMs).toBe(60000);
  });

  it('clamps jitter pct above 1 down to 1', () => {
    process.env.WIGOLO_CRAWL_JITTER_PCT = '2.5';
    resetConfig();
    expect(getConfig().crawlJitterPct).toBe(1);
  });

  it('clamps negative jitter pct up to 0', () => {
    process.env.WIGOLO_CRAWL_JITTER_PCT = '-0.4';
    resetConfig();
    expect(getConfig().crawlJitterPct).toBe(0);
  });

  it('accepts jitter pct of 0 (disables jitter)', () => {
    process.env.WIGOLO_CRAWL_JITTER_PCT = '0';
    resetConfig();
    expect(getConfig().crawlJitterPct).toBe(0);
  });
});
