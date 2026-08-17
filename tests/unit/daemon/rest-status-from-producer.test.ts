import { describe, it, expect, vi } from 'vitest';
import type { RawFetchResult, StageError, StageResult, FetchOutput } from '../../../src/types.js';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(() => undefined),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn(() => ({ usable: false, stale: false })),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/cache/change-detector.js', () => ({ detectChange: vi.fn(() => ({ changed: false })) }));

import { handleFetch } from '../../../src/tools/fetch.js';
import { statusForStageResult, type StageFailure } from '../../../src/daemon/rest/errors.js';
import { ChallengeBlockedError } from '../../../src/fetch/browser-pool.js';
import { BROWSER_UNAVAILABLE_ERROR } from '../../../src/fetch/browser-acquire.js';

/**
 * These tests exist because the previous ones could not fail.
 *
 * `statusForStageResult` keys on reason CODES. The old suite handed it the code
 * in `error_reason` and a dummy string in `error` — the exact inverse of what
 * `handleFetch` emits, which puts the code in `error` and human prose in
 * `error_reason`. So the mapping table passed its tests while every real REST
 * failure fell through to 500. Every input below is therefore either an
 * unstubbed `handleFetch` return or a value produced by the code that raises it,
 * never a literal shaped to satisfy the function under test.
 */

function routerReturning(result: RawFetchResult | StageError) {
  return { fetch: vi.fn(async () => result), getDomainStats: vi.fn() } as never;
}

/** A router that fails the test if it is reached — proves the failure came from a pre-network guard. */
function routerNeverCalled() {
  return {
    fetch: vi.fn(async () => {
      throw new Error('router must not be reached');
    }),
    getDomainStats: vi.fn(),
  } as never;
}

function asFailure(res: StageResult<FetchOutput>): StageFailure {
  if (res.ok) throw new Error('expected handleFetch to fail');
  return { error: res.error, error_reason: res.error_reason, stage: res.stage ?? 'fetch' };
}

describe('statusForStageResult against shapes the producer actually emits', () => {
  it('maps a real pre-network guard refusal to 400, not 500', async () => {
    // No stubbing of the guard: handleFetch's own SSRF gate produces this.
    const res = await handleFetch(
      { url: 'http://169.254.169.254/latest/meta-data' },
      routerNeverCalled(),
    );
    const f = asFailure(res);
    expect(f.error).toBe('invalid_url');
    expect(statusForStageResult(f)).toBe(400);
  });

  it('maps a challenge block to 502 so callers read it as "upstream failed, retry may help"', async () => {
    // The code is read off the production error class the browser tier throws,
    // so renaming it there breaks this test rather than silently unmapping it.
    const raised = new ChallengeBlockedError('https://blocked.example/x');
    const res = await handleFetch(
      { url: 'https://blocked.example/x' },
      routerReturning({
        error: raised.code,
        error_reason: raised.message,
        stage: 'fetch',
        http_status: 403,
      }),
    );
    const f = asFailure(res);
    expect(f.error).toBe('blocked_by_challenge');
    expect(statusForStageResult(f)).toBe(502);
  });

  it('maps a missing browser engine to 503, keyed on the code and not the prose', async () => {
    const res = await handleFetch(
      { url: 'https://needs-browser.example/x' },
      routerReturning({
        error: 'browser_engine_unavailable',
        // The real prose the acquire path emits, imported rather than retyped.
        error_reason: BROWSER_UNAVAILABLE_ERROR,
        stage: 'fetch',
      }),
    );
    const f = asFailure(res);
    expect(statusForStageResult(f)).toBe(503);
  });

  it('reads the field the producer fills — the inverted shape must NOT map', async () => {
    // This is the regression that let the bug survive. If the mapping ever goes
    // back to reading `error_reason`, the first expectation below flips to 503
    // and the second to 500, and both fail.
    const res = await handleFetch(
      { url: 'https://needs-browser.example/x' },
      routerReturning({
        error: 'browser_engine_unavailable',
        error_reason: BROWSER_UNAVAILABLE_ERROR,
        stage: 'fetch',
      }),
    );
    const real = asFailure(res);
    const inverted: StageFailure = {
      error: real.error_reason,
      error_reason: real.error,
      stage: real.stage,
    };
    expect(statusForStageResult(inverted)).toBe(500);
    expect(statusForStageResult(real)).toBe(503);
  });

  it('still falls through to 500 for a code with no table entry — the mapping is not a catch-all', async () => {
    // Negative direction: a real handleFetch failure whose code is genuinely
    // unclassified must keep 500. A fix that returned 502 for everything would
    // pass every test above and fail this one.
    const res = await handleFetch(
      { url: 'https://unknown.example/x' },
      routerReturning({
        error: 'playwright_not_installed',
        error_reason: 'Stealth mode requested but a browser engine is not installed',
        stage: 'fetch',
      }),
    );
    const f = asFailure(res);
    expect(statusForStageResult(f)).toBe(500);
  });

  it('a free-text reason that mentions a mapped concept never drives the status', async () => {
    const res = await handleFetch(
      { url: 'https://prose.example/x' },
      routerReturning({
        error: 'some_novel_code',
        error_reason: 'blocked_by_challenge browser_engine_unavailable invalid_url',
        stage: 'fetch',
      }),
    );
    const f = asFailure(res);
    expect(statusForStageResult(f)).toBe(500);
  });
});
