import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getCodeEngines,
  _resetCodeEnginesForTest,
} from '../../../../../src/search/core/verticals/code.js';
import { _resetBreakersForTest } from '../../../../../src/search/core/engine-base.js';

describe('getCodeEngines', () => {
  const originalBraveKey = process.env.BRAVE_API_KEY;
  const originalGithubToken = process.env.WIGOLO_GITHUB_TOKEN;

  beforeEach(async () => {
    delete process.env.BRAVE_API_KEY;
    process.env.WIGOLO_GITHUB_TOKEN = 'test-token';
    const { resetConfig } = await import('../../../../../src/config.js');
    resetConfig();
    _resetCodeEnginesForTest();
    _resetBreakersForTest();
  });

  afterEach(async () => {
    if (originalBraveKey === undefined) {
      delete process.env.BRAVE_API_KEY;
    } else {
      process.env.BRAVE_API_KEY = originalBraveKey;
    }
    if (originalGithubToken === undefined) {
      delete process.env.WIGOLO_GITHUB_TOKEN;
    } else {
      process.env.WIGOLO_GITHUB_TOKEN = originalGithubToken;
    }
    const { resetConfig } = await import('../../../../../src/config.js');
    resetConfig();
    _resetCodeEnginesForTest();
  });

  it('returns six entries with a GitHub token (github-code, stackoverflow, devdocs, duckduckgo, mdn, crates-io)', () => {
    expect(getCodeEngines()).toHaveLength(6);
  });

  it('lists github-code, stackoverflow, devdocs, duckduckgo, mdn, crates-io (preserving names)', () => {
    const names = getCodeEngines().map((e) => e.engine.name).sort();
    expect(names).toEqual([
      'crates-io',
      'devdocs',
      'duckduckgo',
      'github-code',
      'mdn',
      'stackoverflow',
    ]);
  });

  it('omits github-code when WIGOLO_GITHUB_TOKEN is unset', async () => {
    // WHY: GitHub code search 401s without auth, so an unauthenticated engine
    // only burns a slot and trips its breaker on every code query (#649).
    delete process.env.WIGOLO_GITHUB_TOKEN;
    const { resetConfig } = await import('../../../../../src/config.js');
    resetConfig();
    _resetCodeEnginesForTest();
    const names = getCodeEngines().map((e) => e.engine.name);
    expect(names).not.toContain('github-code');
    expect(names).toHaveLength(5);
  });

  it('adds brave when BRAVE_API_KEY is set', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    const { resetConfig } = await import('../../../../../src/config.js');
    resetConfig();
    _resetCodeEnginesForTest();
    const names = getCodeEngines().map((e) => e.engine.name).sort();
    expect(names).toContain('brave');
  });

  it('memoizes — two calls return the same array reference', () => {
    const a = getCodeEngines();
    const b = getCodeEngines();
    expect(a).toBe(b);
  });

  it('_resetCodeEnginesForTest clears the cache', () => {
    const a = getCodeEngines();
    _resetCodeEnginesForTest();
    const b = getCodeEngines();
    expect(a).not.toBe(b);
  });

  it('marks MDN and crates-io as secondary and leaves the other engines primary', () => {
    const entries = getCodeEngines();
    const secondaries = ['mdn', 'crates-io'];
    for (const name of secondaries) {
      const entry = entries.find((e) => e.engine.name === name);
      expect(entry?.secondary).toBe(true);
    }
    for (const e of entries) {
      if (secondaries.includes(e.engine.name)) continue;
      expect(e.secondary ?? false).toBe(false);
    }
  });

  it('weights primary code engines higher than MDN', () => {
    const entries = getCodeEngines();
    const w = (name: string) => entries.find((e) => e.engine.name === name)?.weight ?? 0;
    expect(w('github-code')).toBeGreaterThan(w('stackoverflow'));
    expect(w('stackoverflow')).toBeGreaterThan(w('mdn'));
    expect(w('duckduckgo')).toBeGreaterThan(w('mdn'));
    expect(w('devdocs')).toBeGreaterThan(w('mdn'));
  });

  it('sets supportsDateFilter true only on stackoverflow', () => {
    const entries = getCodeEngines();
    const f = (name: string) => entries.find((e) => e.engine.name === name)?.supportsDateFilter;
    expect(f('github-code')).toBe(false);
    expect(f('stackoverflow')).toBe(true);
    expect(f('mdn')).toBe(false);
    expect(f('devdocs')).toBe(false);
    expect(f('duckduckgo')).toBe(false);
  });
});
