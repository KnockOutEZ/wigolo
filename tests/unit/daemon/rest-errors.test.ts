import { describe, it, expect } from 'vitest';
import {
  errorEnvelope,
  invalidJson,
  invalidInput,
  unauthorized,
  forbidden,
  notFound,
  methodNotAllowed,
  bodyTooLarge,
  tooManyRequests,
  internalError,
  notImplemented,
  routeTimeout,
  statusForStageResult,
  statusForCrawlCacheError,
  statusForSearchData,
} from '../../../src/daemon/rest/errors.js';
import { SSRF_CODES } from '../../../src/watch/ssrf.js';

describe('error envelope builders', () => {
  it('base envelope shape', () => {
    const e = errorEnvelope('invalid_input', 'bad', { stage: 'validate', hint: 'fix it' });
    expect(e).toEqual({ ok: false, error: 'bad', error_reason: 'invalid_input', stage: 'validate', hint: 'fix it' });
  });

  it('400 invalid_json', () => {
    const { status, body } = invalidJson();
    expect(status).toBe(400);
    expect(body.error_reason).toBe('invalid_json');
  });

  it('400 invalid_input', () => {
    const { status, body } = invalidInput('field x required');
    expect(status).toBe(400);
    expect(body.error_reason).toBe('invalid_input');
  });

  it('401 unauthorized (hint names env var)', () => {
    const { status, body } = unauthorized('need token');
    expect(status).toBe(401);
    expect(body.error_reason).toBe('unauthorized');
  });

  it('403 forbidden', () => {
    expect(forbidden('host_not_allowed', 'no').status).toBe(403);
  });

  it('404 not found', () => {
    expect(notFound().status).toBe(404);
  });

  it('405 with Allow header info', () => {
    const { status, body, headers } = methodNotAllowed('POST');
    expect(status).toBe(405);
    expect(headers.Allow).toBe('POST');
    expect(body.error_reason).toBe('method_not_allowed');
  });

  it('413 with cap in hint', () => {
    const { status, body } = bodyTooLarge(1048576);
    expect(status).toBe(413);
    expect(body.hint).toContain('1048576');
  });

  it('429 with Retry-After: 5', () => {
    const { status, headers } = tooManyRequests();
    expect(status).toBe(429);
    expect(headers['Retry-After']).toBe('5');
  });

  it('500 internal', () => {
    expect(internalError().status).toBe(500);
  });

  it('501 not_implemented', () => {
    const { status, body } = notImplemented('crawl');
    expect(status).toBe(501);
    expect(body.error_reason).toBe('not_implemented');
  });

  it('504 route_timeout', () => {
    const { status, body } = routeTimeout('crawl');
    expect(status).toBe(504);
    expect(body.error_reason).toBe('route_timeout');
  });
});

describe('statusForStageResult', () => {
  it('unavailability code → 503', () => {
    expect(statusForStageResult({ error: 'x', error_reason: 'browser_engine_unavailable', stage: 'fetch' })).toBe(503);
  });
  it('fetch-stage upstream code → 502', () => {
    expect(statusForStageResult({ error: 'x', error_reason: 'blocked_by_challenge', stage: 'fetch' })).toBe(502);
    expect(statusForStageResult({ error: 'x', error_reason: 'fetch_failed', stage: 'fetch' })).toBe(502);
  });
  it('semantic-validation allowlist → 400', () => {
    expect(statusForStageResult({ error: 'x', error_reason: 'invalid_url', stage: 'validate' })).toBe(400);
  });
  it('unknown reason → 500', () => {
    expect(statusForStageResult({ error: 'x', error_reason: 'some_novel_reason', stage: 'extract' })).toBe(500);
  });
  it('NEGATIVE: a reason containing the word "timeout" does NOT map to 504', () => {
    expect(statusForStageResult({ error: 'connection timeout occurred', error_reason: 'network_timeout', stage: 'fetch' })).not.toBe(504);
    // network_timeout is not in the fetch upstream allowlist nor unavailability → 500
    expect(statusForStageResult({ error: 'connection timeout occurred', error_reason: 'network_timeout', stage: 'fetch' })).toBe(500);
  });
});

describe('statusForCrawlCacheError (in-band error string keyed on ssrf codes)', () => {
  it('ssrf private-target refusal → 400', () => {
    expect(statusForCrawlCacheError(SSRF_CODES.PRIVATE_TARGET)).toBe(400);
    expect(statusForCrawlCacheError(SSRF_CODES.METADATA)).toBe(400);
    expect(statusForCrawlCacheError(SSRF_CODES.BAD_PROTOCOL)).toBe(400);
    expect(statusForCrawlCacheError(SSRF_CODES.INVALID_URL)).toBe(400);
  });
  it('upstream fetch code → 502', () => {
    expect(statusForCrawlCacheError('fetch_failed')).toBe(502);
    expect(statusForCrawlCacheError('blocked_by_challenge')).toBe(502);
  });
  it('unknown / free-text → 500', () => {
    expect(statusForCrawlCacheError('clear requires at least one filter')).toBe(500);
    expect(statusForCrawlCacheError('some error mentioning timeout')).toBe(500);
  });
});

describe('statusForSearchData', () => {
  it('ok:true with data.error → treated as failure (500)', () => {
    expect(statusForSearchData({ error: 'all engines failed' })).toBe(500);
  });
  it('warning-only stays 200 (null = no remap)', () => {
    expect(statusForSearchData({ warning: 'degraded' })).toBeNull();
    expect(statusForSearchData({ results: [] })).toBeNull();
  });
});

describe('adapter keys ⊆ SSRF codes (drift gate)', () => {
  it('every ssrf code maps to 400', () => {
    for (const code of Object.values(SSRF_CODES)) {
      expect(statusForCrawlCacheError(code)).toBe(400);
    }
  });
});
