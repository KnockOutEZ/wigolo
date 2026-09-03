import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, resetConfig } from '../../../src/config.js';
import { resetPersistedConfig } from '../../../src/persisted-config.js';
import {
  DEFAULT_ORIGIN_BUDGET,
  DEFAULT_ORIGIN_BUDGET_WINDOW_MS,
  DEFAULT_ANONYMOUS_ORIGIN_BUDGET,
} from '../../../src/companion/origin-budget.js';

/**
 * SD6-C2 — the pacing window is only a rail the human can live with if the human can change it, and
 * `env > persisted > default` is the project's one precedence order. A key that resolved from the
 * default while a persisted setting sat unread would look identical to a working one right up to the
 * moment somebody raised the window and nothing moved.
 *
 * The window and the limit are asserted TOGETHER on purpose: once a window exists the limit is a rate,
 * not a total, and a config that reached one but not the other would mean something nobody configured.
 */
describe('pacing config — env > persisted > default', () => {
  const originalEnv = process.env;
  let dir: string;
  let configPath: string;

  const persist = (settings: Record<string, unknown>) => {
    writeFileSync(configPath, JSON.stringify({ settings }));
    resetPersistedConfig();
    resetConfig();
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    dir = mkdtempSync(join(tmpdir(), 'wigolo-pacing-config-'));
    configPath = join(dir, 'config.json');
    process.env.WIGOLO_CONFIG_PATH = configPath;
    delete process.env.WIGOLO_STUDIO_ORIGIN_BUDGET;
    delete process.env.WIGOLO_STUDIO_ORIGIN_BUDGET_WINDOW_MS;
    delete process.env.WIGOLO_STUDIO_ANONYMOUS_ORIGIN_BUDGET;
    resetPersistedConfig();
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
    resetPersistedConfig();
    resetConfig();
  });

  it('falls back to the library constants, so the shipped rail is pin 2 with no config at all', () => {
    const cfg = getConfig();
    expect(cfg.studioOriginBudget).toBe(DEFAULT_ORIGIN_BUDGET);
    expect(cfg.studioOriginBudgetWindowMs).toBe(DEFAULT_ORIGIN_BUDGET_WINDOW_MS);
    expect(cfg.studioAnonymousOriginBudget).toBe(DEFAULT_ANONYMOUS_ORIGIN_BUDGET);
  });

  it('reads a persisted window and limit', () => {
    persist({ studioOriginBudget: 30, studioOriginBudgetWindowMs: 120_000 });
    expect(getConfig().studioOriginBudget).toBe(30);
    expect(getConfig().studioOriginBudgetWindowMs).toBe(120_000);
  });

  it('lets the environment override the persisted window and limit', () => {
    persist({ studioOriginBudget: 30, studioOriginBudgetWindowMs: 120_000 });
    process.env.WIGOLO_STUDIO_ORIGIN_BUDGET = '11';
    process.env.WIGOLO_STUDIO_ORIGIN_BUDGET_WINDOW_MS = '45000';
    resetConfig();
    expect(getConfig().studioOriginBudget).toBe(11);
    expect(getConfig().studioOriginBudgetWindowMs).toBe(45_000);
  });

  it('resolves each key independently — an env window does not drag the limit off its persisted value', () => {
    // The two keys arriving from different layers is the ordinary case (a persisted policy plus a
    // one-off override), and a resolver that read them as a pair would silently discard one.
    persist({ studioOriginBudget: 30, studioOriginBudgetWindowMs: 120_000 });
    process.env.WIGOLO_STUDIO_ORIGIN_BUDGET_WINDOW_MS = '45000';
    resetConfig();
    expect(getConfig().studioOriginBudget).toBe(30);
    expect(getConfig().studioOriginBudgetWindowMs).toBe(45_000);
  });

  it('ignores an unparseable env window rather than resolving it to NaN', () => {
    // A NaN window reaches `OriginBudget`, which falls back to the default — but only because it
    // checks. Config resolving to NaN at all is the bug worth pinning here.
    process.env.WIGOLO_STUDIO_ORIGIN_BUDGET_WINDOW_MS = 'ten minutes';
    resetConfig();
    expect(getConfig().studioOriginBudgetWindowMs).toBe(DEFAULT_ORIGIN_BUDGET_WINDOW_MS);
  });
});
