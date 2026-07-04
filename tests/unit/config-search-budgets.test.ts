import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, resetConfig } from '../../src/config.js';

const keys = [
  'SEARCH_FETCH_TIMEOUT_BALANCED_MS', 'SEARCH_FETCH_TIMEOUT_DEEP_MS',
  'SEARCH_STAGE_BUDGET_BALANCED_MS', 'SEARCH_STAGE_BUDGET_DEEP_MS',
  'SEARCH_NARROW_RENDER_MAX_CANDIDATES',
];

describe('search tier fetch budgets', () => {
  beforeEach(() => resetConfig());
  afterEach(() => { keys.forEach((k) => delete process.env[k]); resetConfig(); });

  it('defaults: balanced 3000/4000, deep 8000/10000', () => {
    const c = getConfig();
    expect(c.searchFetchTimeoutBalancedMs).toBe(3000);
    expect(c.searchStageBudgetBalancedMs).toBe(4000);
    expect(c.searchFetchTimeoutDeepMs).toBe(8000);
    expect(c.searchStageBudgetDeepMs).toBe(10000);
  });

  it('honors env overrides', () => {
    process.env.SEARCH_FETCH_TIMEOUT_BALANCED_MS = '2500';
    process.env.SEARCH_STAGE_BUDGET_BALANCED_MS = '3500';
    resetConfig();
    const c = getConfig();
    expect(c.searchFetchTimeoutBalancedMs).toBe(2500);
    expect(c.searchStageBudgetBalancedMs).toBe(3500);
  });
});

describe('narrow-set render escalation bound', () => {
  beforeEach(() => resetConfig());
  afterEach(() => { keys.forEach((k) => delete process.env[k]); resetConfig(); });

  it('defaults to a bounded few (3) so escalation stays cost-controlled', () => {
    expect(getConfig().searchNarrowRenderMaxCandidates).toBe(3);
  });

  it('honors an env override (tune the bound)', () => {
    process.env.SEARCH_NARROW_RENDER_MAX_CANDIDATES = '5';
    resetConfig();
    expect(getConfig().searchNarrowRenderMaxCandidates).toBe(5);
  });

  it('accepts 0 to disable render escalation entirely', () => {
    process.env.SEARCH_NARROW_RENDER_MAX_CANDIDATES = '0';
    resetConfig();
    expect(getConfig().searchNarrowRenderMaxCandidates).toBe(0);
  });
});
