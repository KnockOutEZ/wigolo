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
  codeForCrawlCacheError,
  statusForSearchData,
  FETCH_UPSTREAM_REASONS,
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

/**
 * A StageResult carries the reason CODE in `error` and human prose in
 * `error_reason` — the opposite of the REST envelope's field naming (see the
 * deliberate swap in dispatch.ts's `stageFailure`). These cases used to be
 * written the other way round, which is why the mapping could be dead in
 * production while this file stayed green. Producer-derived coverage lives in
 * rest-status-from-producer.test.ts; these stay as the table's unit cases.
 */
describe('statusForStageResult', () => {
  it('unavailability code → 503', () => {
    expect(statusForStageResult({ error: 'browser_engine_unavailable', error_reason: 'the browser engine is not installed', stage: 'fetch' })).toBe(503);
  });
  it('fetch-stage upstream code → 502', () => {
    expect(statusForStageResult({ error: 'blocked_by_challenge', error_reason: 'bot protection served a challenge page', stage: 'fetch' })).toBe(502);
    expect(statusForStageResult({ error: 'fetch_failed', error_reason: 'the request did not complete', stage: 'fetch' })).toBe(502);
  });
  it('semantic-validation allowlist → 400', () => {
    expect(statusForStageResult({ error: 'invalid_url', error_reason: 'the url could not be parsed', stage: 'validate' })).toBe(400);
  });
  it('unknown code → 500', () => {
    expect(statusForStageResult({ error: 'some_novel_code', error_reason: 'something went wrong', stage: 'extract' })).toBe(500);
  });
  it('NEGATIVE: prose containing the word "timeout" does NOT map to 504', () => {
    expect(statusForStageResult({ error: 'network_timeout', error_reason: 'connection timeout occurred', stage: 'fetch' })).not.toBe(504);
    // network_timeout is not in the fetch upstream allowlist nor unavailability → 500
    expect(statusForStageResult({ error: 'network_timeout', error_reason: 'connection timeout occurred', stage: 'fetch' })).toBe(500);
  });
  it('NEGATIVE: prose naming a mapped code does not promote the status', () => {
    expect(statusForStageResult({ error: 'some_novel_code', error_reason: 'blocked_by_challenge', stage: 'fetch' })).toBe(500);
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

describe('codeForCrawlCacheError (the code half of the same in-band envelope)', () => {
  /**
   * WHY THIS EXISTS. `statusForCrawlCacheError` above is fed hand-written codes, and that is fine for
   * a status table — but it says nothing about what the PRODUCERS emit. They emit prose: every site
   * that sets `CrawlOutput.error` / `CacheOutput.error` in the tree writes `err.message`, an
   * SsrfRejection's `reason` (not its `code`), `describeStageError`'s sentence, or an English
   * instruction. So the envelope needed a code that does NOT come from that string, and the fallback
   * branch — not the pass-through — is the one real traffic takes.
   */
  it('prose falls back to the stage code, and the two stages do not share one', () => {
    // Real producer strings, copied from the sites that emit them.
    const prose = [
      'Database not initialized. Call initDatabase() first.',   // tools/cache.ts top-level catch
      'clear requires at least one filter (query, url_pattern, or since)', // tools/cache.ts clear path
      'url resolves to a private IPv4 (10.0.0.5, 10/8)',        // tools/crawl.ts seed guard (.reason)
      'Error: fetch_failed: HTTP 404 from https://x.example/y', // tools/crawl.ts map catch
    ];
    for (const p of prose) {
      expect(codeForCrawlCacheError(p, 'crawl')).toBe('crawl_failed');
      expect(codeForCrawlCacheError(p, 'cache')).toBe('cache_failed');
    }
  });

  it('a value that IS a known code is passed through unchanged, on both stages', () => {
    // Enumerated from production for the same reason the drift gate below is: a new upstream reason
    // must be covered by being ADDED to the set, not by someone remembering to re-type it here.
    for (const code of [...Object.values(SSRF_CODES), ...FETCH_UPSTREAM_REASONS]) {
      expect(codeForCrawlCacheError(code, 'crawl')).toBe(code);
      expect(codeForCrawlCacheError(code, 'cache')).toBe(code);
    }
  });

  it('DRIFT GATE: the code and the status classify every key the same way', () => {
    // The two functions are separate but read the SAME two sets. This is what makes that structural
    // rather than a comment: a key recognised by one must be recognised by the other, so a status
    // could never say "known upstream failure, 502" while the code said "generic crawl_failed".
    //
    // BOTH recognised sets are enumerated from production, not re-typed. The upstream reasons used to
    // be four hand-written literals here while the ssrf half was already dynamic, so a FIFTH member
    // added to `FETCH_UPSTREAM_REASONS` alone would never have been swept by this gate — it would pass
    // on the four keys it still knew about while the new code went unchecked. Reading the set is what
    // makes "every key" true of the population rather than of this list.
    const keys = [
      ...Object.values(SSRF_CODES),
      ...FETCH_UPSTREAM_REASONS,
      'Database not initialized. Call initDatabase() first.',
      'some error mentioning timeout',
    ];
    // Outside signal: an empty or accidentally-emptied set would make the loop below vacuous, and a
    // vacuous drift gate reads exactly like a passing one.
    expect(FETCH_UPSTREAM_REASONS.size).toBeGreaterThanOrEqual(4);
    expect(keys.length).toBe(Object.values(SSRF_CODES).length + FETCH_UPSTREAM_REASONS.size + 2);
    for (const k of keys) {
      const passedThrough = codeForCrawlCacheError(k, 'crawl') === k;
      const statusIsSpecific = statusForCrawlCacheError(k) !== 500;
      expect(passedThrough).toBe(statusIsSpecific);
    }
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
