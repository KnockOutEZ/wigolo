/**
 * `search.engine_failure` at the circuit breaker.
 *
 * The two arms that carry the design are the silent ones: a call the breaker DECLINED to
 * make (open breaker, or throttled) is not a failure the engine had, and counting it would
 * make an open breaker look like an engine getting steadily worse — the exact signal this
 * event exists to measure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  return {
    keychainAvailable: vi.fn(() => true),
    keychainSet: vi.fn((s: string, u: string, v: string) => { store.set(`${s}:${u}`, v); }),
    keychainGet: vi.fn((s: string, u: string) => store.get(`${s}:${u}`) ?? null),
    keychainDelete: vi.fn((s: string, u: string) => { store.delete(`${s}:${u}`); }),
  };
});

const { resetConfig } = await import('../../../src/config.js');
const { AccountStateStore } = await import('../../../src/account/state.js');
const { queuePath } = await import('../../../src/telemetry/queue.js');
const telemetry = await import('../../../src/telemetry/index.js');
const { wrapWithRetryAndBreaker, resetBreakers } = await import('../../../src/search/core/engine-base.js');

import type { SearchEngine } from '../../../src/types.js';

const ORIGINAL_ENV = process.env;

/** A query with a token nothing else in the tree contains, so its absence is provable. */
const PLANTED_QUERY = 'zqxjkvw private merger terms 2026';

let dataDir: string;

function activate(): void {
  new AccountStateStore(dataDir).write({ account_id: 'acc_engine_telemetry' });
}

function queueBytes(): string {
  const path = queuePath(dataDir);
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function queuedEvents(): { name: string; props: Record<string, unknown> }[] {
  return queueBytes()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { name: string; props: Record<string, unknown> });
}

function failingEngine(name: string, err: unknown): SearchEngine {
  return { name, search: vi.fn(async () => { throw err; }) };
}

describe('search.engine_failure at the circuit breaker', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-engine-telemetry-'));
    process.env = { ...ORIGINAL_ENV };
    process.env.WIGOLO_DATA_DIR = dataDir;
    // Forced ON rather than deleted: leaving it unset makes the switch depend on the
    // ambient absence of a persisted setting, and a byte search over a queue that was
    // silent for that reason passes vacuously. Measured — a settings file with
    // `telemetryEnabled: false` produced exactly that empty-queue false pass.
    process.env.WIGOLO_TELEMETRY = 'on';
    resetConfig();
    telemetry._resetTelemetryForTest();
    resetBreakers();
  });

  afterEach(() => {
    telemetry._resetTelemetryForTest();
    process.env = ORIGINAL_ENV;
    resetConfig();
    resetBreakers();
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports the engine id and error class once per exhausted call', async () => {
    activate();
    const wrapped = wrapWithRetryAndBreaker(
      failingEngine('mojeek', new Error('connect ECONNREFUSED 10.0.0.1:443')),
      { retryAttempts: 1 },
    );

    await expect(wrapped.search(PLANTED_QUERY)).rejects.toThrow();

    const failures = queuedEvents().filter((e) => e.name === 'search.engine_failure');
    expect(failures).toHaveLength(1);
    expect(failures[0].props).toEqual({ engine: 'mojeek', error_class: 'network' });
  });

  it('never puts the query on the wire', async () => {
    activate();
    const wrapped = wrapWithRetryAndBreaker(
      failingEngine('brave', new Error(`upstream rejected the search for "${PLANTED_QUERY}"`)),
      { retryAttempts: 1 },
    );

    await expect(wrapped.search(PLANTED_QUERY)).rejects.toThrow();

    // The error MESSAGE itself contains the query. The classifier reads it and returns an
    // enum; nothing derived from it reaches the queue.
    const bytes = queueBytes();
    expect(bytes).not.toContain('zqxjkvw');
    expect(bytes).not.toContain('merger');
    expect(queuedEvents().filter((e) => e.name === 'search.engine_failure')).toHaveLength(1);
  });

  it('degrades an engine outside the enum to `other` rather than dropping its failure', async () => {
    activate();
    // `rss-feed` is a real SearchEngine in the tree with no ENGINE_IDS member. A new
    // engine's failures must not go silently uncounted — that is the case where the
    // reliability signal matters most.
    const wrapped = wrapWithRetryAndBreaker(
      failingEngine('rss-feed', new Error('getaddrinfo ENOTFOUND feeds.invalid')),
      { retryAttempts: 1 },
    );

    await expect(wrapped.search(PLANTED_QUERY)).rejects.toThrow();

    const failures = queuedEvents().filter((e) => e.name === 'search.engine_failure');
    expect(failures).toHaveLength(1);
    expect(failures[0].props).toEqual({ engine: 'other', error_class: 'dns' });
  });

  it('reports once, not once per retry attempt', async () => {
    activate();
    const engine = failingEngine('bing', new Error('socket hang up'));
    const wrapped = wrapWithRetryAndBreaker(engine, { retryAttempts: 3 });

    await expect(wrapped.search(PLANTED_QUERY)).rejects.toThrow();

    expect(engine.search).toHaveBeenCalledTimes(3);
    expect(queuedEvents().filter((e) => e.name === 'search.engine_failure')).toHaveLength(1);
  });

  it('stays silent for a call the open breaker declined to make', async () => {
    activate();
    const wrapped = wrapWithRetryAndBreaker(
      failingEngine('duckduckgo', new Error('boom')),
      { retryAttempts: 1, failureThreshold: 1, cooldownMs: 60_000 },
    );

    // First call fails for real and trips the breaker: one event.
    await expect(wrapped.search(PLANTED_QUERY)).rejects.toThrow();
    // Second call is refused by the open breaker before the engine is touched.
    await expect(wrapped.search(PLANTED_QUERY)).rejects.toThrow(/unavailable|breaker|cooling/i);

    expect(queuedEvents().filter((e) => e.name === 'search.engine_failure')).toHaveLength(1);
  });

  it('writes nothing on an install that was never activated', async () => {
    const wrapped = wrapWithRetryAndBreaker(
      failingEngine('wikipedia', new Error('connect ETIMEDOUT')),
      { retryAttempts: 1 },
    );

    await expect(wrapped.search(PLANTED_QUERY)).rejects.toThrow();

    expect(queueBytes()).toBe('');
  });
});
