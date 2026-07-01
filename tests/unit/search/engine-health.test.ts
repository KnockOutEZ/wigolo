// Cold-start engine health summary tests.
//
// WHY: doctor needs to surface the engine-pool state at a glance so users
// can see whether brave is gated, whether github-code needs a token, etc.
// The summary is REGISTRY-level (no live network) — these tests pin the
// shape and the key-availability branching.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getEngineHealthSummary,
  getRegisteredEngineEntries,
} from '../../../src/search/core/engine-health.js';
import {
  wrapWithRetryAndBreaker,
  _resetBreakersForTest,
} from '../../../src/search/core/engine-base.js';
import { _resetGeneralEnginesForTest } from '../../../src/search/core/verticals/general.js';
import { _resetImageEnginesForTest } from '../../../src/search/core/verticals/images.js';
import { _resetCodeEnginesForTest } from '../../../src/search/core/verticals/code.js';
import { resetConfig } from '../../../src/config.js';

describe('getEngineHealthSummary', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.BRAVE_API_KEY;
    delete process.env.WIGOLO_GITHUB_TOKEN;
    resetConfig();
    _resetGeneralEnginesForTest();
    _resetImageEnginesForTest();
    _resetCodeEnginesForTest();
  });

  afterEach(() => {
    process.env = origEnv;
    resetConfig();
    _resetGeneralEnginesForTest();
    _resetImageEnginesForTest();
    _resetCodeEnginesForTest();
  });

  it('lists at least one entry per vertical including images', () => {
    const summary = getEngineHealthSummary();
    const verticals = new Set(summary.map((e) => e.vertical));
    expect(verticals).toContain('general');
    expect(verticals).toContain('news');
    expect(verticals).toContain('code');
    expect(verticals).toContain('docs');
    expect(verticals).toContain('papers');
    // S11a: images vertical exists in the pool now.
    expect(verticals).toContain('images');
  });

  it('marks engines as ok when no key is required (e.g. duckduckgo, ddg-image, mojeek)', () => {
    const summary = getEngineHealthSummary();
    const ddg = summary.find((e) => e.name === 'duckduckgo');
    expect(ddg?.status).toBe('ok');
    const ddgImage = summary.find((e) => e.name === 'ddg-image');
    expect(ddgImage?.status).toBe('ok');
    const mojeek = summary.find((e) => e.name === 'mojeek');
    expect(mojeek?.status).toBe('ok');
  });

  // Mojeek's 403s are IP-reputation
  // driven (confirmed in src/search/engines/mojeek.ts), NOT UA-fixable. A
  // user seeing mojeek "ok" but absent from telemetry deserves to know WHY.
  // The note is informational — it does not change status or block dispatch.
  it('attaches an IP-reputation note to mojeek so its intermittent absence is honest', () => {
    const summary = getEngineHealthSummary();
    const mojeek = summary.find((e) => e.name === 'mojeek');
    expect(mojeek?.note).toMatch(/IP reputation/i);
  });

  it('does not attach a note to engines without a known limitation', () => {
    const summary = getEngineHealthSummary();
    const ddg = summary.find((e) => e.name === 'duckduckgo');
    expect(ddg?.note).toBeUndefined();
  });

  it('does not register wiby in any vertical (removed)', () => {
    const summary = getEngineHealthSummary();
    expect(summary.find((e) => e.name === 'wiby')).toBeUndefined();
  });

  it('flags brave as disabled when BRAVE_API_KEY is missing (gated OUT of pool)', () => {
    const summary = getEngineHealthSummary();
    const brave = summary.find((e) => e.name === 'brave');
    expect(brave).toBeDefined();
    expect(brave!.status).toBe('disabled');
    expect(brave!.hint).toMatch(/BRAVE_API_KEY/);
  });

  it('flags brave-image as disabled when BRAVE_API_KEY is missing', () => {
    const summary = getEngineHealthSummary();
    const braveImg = summary.find((e) => e.name === 'brave-image');
    expect(braveImg).toBeDefined();
    expect(braveImg!.status).toBe('disabled');
    expect(braveImg!.hint).toMatch(/BRAVE_API_KEY/);
    expect(braveImg!.vertical).toBe('images');
  });

  it('flags github-code as needs-key when WIGOLO_GITHUB_TOKEN is missing (engine still in pool)', () => {
    const summary = getEngineHealthSummary();
    const gh = summary.find((e) => e.name === 'github-code');
    expect(gh).toBeDefined();
    expect(gh!.status).toBe('needs-key');
    expect(gh!.hint).toMatch(/WIGOLO_GITHUB_TOKEN/);
  });

  it('marks brave as ok when BRAVE_API_KEY is set', () => {
    process.env.BRAVE_API_KEY = 'test-key';
    resetConfig();
    _resetGeneralEnginesForTest();
    _resetImageEnginesForTest();
    _resetCodeEnginesForTest();
    const summary = getEngineHealthSummary();
    const brave = summary.find((e) => e.name === 'brave' && e.vertical === 'general');
    expect(brave?.status).toBe('ok');
    const braveImg = summary.find((e) => e.name === 'brave-image');
    expect(braveImg?.status).toBe('ok');
  });

  it('marks github-code as ok when WIGOLO_GITHUB_TOKEN is set', () => {
    process.env.WIGOLO_GITHUB_TOKEN = 'test-token';
    const summary = getEngineHealthSummary();
    const gh = summary.find((e) => e.name === 'github-code');
    expect(gh?.status).toBe('ok');
  });

  // Per-engine breaker state in doctor.
  // WHY: two engines can sit behind open breakers for a whole run with zero
  // user visibility — doctor must surface breaker state + the last upstream
  // error.
  describe('breaker state join', () => {
    beforeEach(() => {
      _resetBreakersForTest();
    });

    afterEach(() => {
      _resetBreakersForTest();
    });

    it('joins open breaker state + lastError onto the matching engine entry', async () => {
      // Trip the shared breaker keyed by the pool engine's name. Breaker
      // state is name-keyed, so a wrapper around a stub engine with the
      // same name shares state with the real pool entry.
      const failing = wrapWithRetryAndBreaker(
        {
          name: 'duckduckgo',
          search: async () => {
            throw new Error('upstream 403 forbidden');
          },
        },
        { failureThreshold: 1, cooldownMs: 60_000 },
      );
      await expect(failing.search('q')).rejects.toThrow('upstream 403 forbidden');

      const summary = getEngineHealthSummary();
      const ddg = summary.find((e) => e.name === 'duckduckgo');
      expect(ddg).toBeDefined();
      expect(ddg!.breaker).toBe('open');
      expect(ddg!.lastError).toContain('upstream 403 forbidden');
    });

    it('omits breaker fields for engines that never dispatched', () => {
      const summary = getEngineHealthSummary();
      const ddg = summary.find((e) => e.name === 'duckduckgo');
      expect(ddg).toBeDefined();
      expect(ddg!.breaker).toBeUndefined();
      expect(ddg!.lastError).toBeUndefined();
    });
  });
});

describe('getRegisteredEngineEntries (doctor --probe-engines source)', () => {
  it('returns the flattened engine entries across all verticals', () => {
    const entries = getRegisteredEngineEntries();
    expect(entries.length).toBeGreaterThan(0);
    const names = new Set(entries.map((e) => e.engine.name));
    expect(names.has('duckduckgo')).toBe(true);
  });
});
