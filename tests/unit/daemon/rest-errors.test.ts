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

// On a StageResult the machine code lives in `error` and the human sentence in
// `error_reason` — the inverse of the REST envelope. Every case below is shaped
// the way src/tools/*.ts actually emits failures.
describe('statusForStageResult', () => {
  it('unavailability code → 503', () => {
    expect(statusForStageResult({ error: 'browser_engine_unavailable', error_reason: 'playwright is not installed', stage: 'fetch' })).toBe(503);
  });
  it('fetch-stage upstream code → 502', () => {
    expect(statusForStageResult({ error: 'blocked_by_challenge', error_reason: 'the site returned a bot challenge', stage: 'fetch' })).toBe(502);
    expect(statusForStageResult({ error: 'fetch_failed', error_reason: 'connection refused', stage: 'fetch' })).toBe(502);
  });
  it('fetch-stage http_<status> code → 502', () => {
    expect(statusForStageResult({ error: 'http_404', error_reason: 'Upstream returned HTTP 404', stage: 'fetch' })).toBe(502);
    expect(statusForStageResult({ error: 'http_503', error_reason: 'Upstream returned HTTP 503', stage: 'fetch' })).toBe(502);
  });
  it('semantic-validation allowlist → 400', () => {
    expect(statusForStageResult({ error: 'invalid_url', error_reason: 'url is not a valid absolute URL', stage: 'fetch' })).toBe(400);
  });
  it('unknown code → 500', () => {
    expect(statusForStageResult({ error: 'some_novel_reason', error_reason: 'something new broke', stage: 'extract' })).toBe(500);
  });
  it('NEGATIVE: a reason sentence containing the word "timeout" does NOT map to 504', () => {
    expect(statusForStageResult({ error: 'network_timeout', error_reason: 'connection timeout occurred', stage: 'fetch' })).not.toBe(504);
    // network_timeout is not in the fetch upstream allowlist nor unavailability → 500
    expect(statusForStageResult({ error: 'network_timeout', error_reason: 'connection timeout occurred', stage: 'fetch' })).toBe(500);
  });
  it('NEGATIVE: a code that only appears in the reason sentence is NOT matched', () => {
    expect(statusForStageResult({ error: 'x', error_reason: 'invalid_url', stage: 'fetch' })).toBe(500);
    expect(statusForStageResult({ error: 'x', error_reason: 'browser_engine_unavailable', stage: 'fetch' })).toBe(500);
  });
  it('NEGATIVE: an http_-prefixed free-text reason is not a status code', () => {
    expect(statusForStageResult({ error: 'http_gateway_wobble', error_reason: 'upstream misbehaved', stage: 'fetch' })).toBe(500);
  });
  it('upstream codes only map to 502 on the fetch stage', () => {
    expect(statusForStageResult({ error: 'fetch_failed', error_reason: 'connection refused', stage: 'extract' })).toBe(500);
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
