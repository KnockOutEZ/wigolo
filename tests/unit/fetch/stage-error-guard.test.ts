import { describe, it, expect, vi } from 'vitest';
import type { RawFetchResult, StageError } from '../../../src/types.js';
import { isStageError, describeStageError } from '../../../src/fetch/error-describe.js';

// WHY THIS FILE EXISTS
//
// `SmartRouter.fetch` returns `RawFetchResult | StageError` in EVERY mode. It once carried a
// second overload promising non-stealth callers a bare `RawFetchResult`, which the
// implementation never honoured — the terminal challenge guard and the navigation guard both
// return stage errors without consulting `mode`. Because the compiler believed the overload,
// it never required anyone to check, and four call sites read `.html` off a refusal.
//
// The tests below pin the two facts that made that silent: a refusal carries none of the
// content fields, and the extractor does not object to being handed one. Everything the
// caller-level tests assert rests on these.

const BLOCKED: StageError = {
  error: 'blocked_by_challenge',
  error_reason: 'Bot protection challenge was not cleared',
  stage: 'fetch',
  http_status: 403,
};

describe('stage-error guard — the shape a refusal actually has', () => {
  it('a refusal carries no html, url, finalUrl or contentType', () => {
    // This is why an unchecked caller produces an EMPTY result rather than a crash: every
    // field it reaches for is simply absent, and reading an absent property is not an error.
    const asAny = BLOCKED as unknown as Record<string, unknown>;
    expect(asAny.html).toBeUndefined();
    expect(asAny.url).toBeUndefined();
    expect(asAny.finalUrl).toBeUndefined();
    expect(asAny.contentType).toBeUndefined();
  });

  it('identifies a refusal and a real result apart', () => {
    const ok: RawFetchResult = {
      url: 'https://example.com/',
      finalUrl: 'https://example.com/',
      html: '<html><body>real</body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http',
      headers: {},
    };
    expect(isStageError(BLOCKED)).toBe(true);
    expect(isStageError(ok)).toBe(false);
  });

  it('does NOT treat a result whose error field is absent or non-string as a refusal', () => {
    // The predicate must key on a STRING error. A caller that merely tested `'error' in x`
    // would misclassify any shape that happens to carry the key.
    expect(isStageError({ error: undefined } as unknown as StageError)).toBe(false);
    expect(isStageError({ error: 500 } as unknown as StageError)).toBe(false);
  });

  it('keeps the machine-readable code in the described reason, not only the prose', () => {
    // Callers persist this string into user-visible `fetch_error` fields. If it collapsed to
    // the prose alone, a bot-protection block would be indistinguishable from a DNS failure
    // for anyone reading the output rather than the logs.
    const described = describeStageError(BLOCKED);
    expect(described).toContain('blocked_by_challenge');
    expect(described).toContain('Bot protection challenge was not cleared');
  });

  it('does not duplicate the code when the reason IS the code', () => {
    expect(describeStageError({ error: 'x', error_reason: 'x', stage: 'fetch' })).toBe('x');
  });
});

describe('stage-error guard — why an unchecked caller goes silent instead of loud', () => {
  it('an extractor handed a refusal produces empty markdown rather than throwing', async () => {
    // The real extractor's observed behaviour, reproduced here as the premise the caller
    // tests depend on. Nothing in the pipeline raises; the page simply becomes nothing. If a
    // future extractor DID throw on undefined html, an unchecked caller would at least be
    // visible — this test would then fail and the caller tests could be reconsidered.
    const { getExtractProvider } = await import('../../../src/providers/extract-provider.js');
    const extractor = await getExtractProvider();
    const refusal = BLOCKED as unknown as RawFetchResult;
    const out = await extractor.extract(refusal.html, refusal.finalUrl, {
      contentType: refusal.contentType,
    });
    expect(out.markdown).toBe('');
    expect(out.title).toBe('');
  });
});

// Guard against the specific narrowing bug the old `src/tools/fetch.ts` check had: a COMPOUND
// condition narrows only the positive branch, so `if ('error' in x && typeof … === 'string')`
// left the union intact afterwards and the else-path still saw `RawFetchResult | StageError`.
// A single-expression type guard narrows both branches. This is asserted behaviourally: after
// the guard returns false, the value must be usable as content.
describe('stage-error guard — narrows the negative branch', () => {
  it('lets a caller reach content fields after a false result', () => {
    const raw: RawFetchResult | StageError = {
      url: 'https://example.com/',
      finalUrl: 'https://example.com/x',
      html: '<p>body</p>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http',
      headers: {},
    };
    const read = vi.fn();
    if (!isStageError(raw)) read(raw.html, raw.finalUrl, raw.contentType);
    expect(read).toHaveBeenCalledWith('<p>body</p>', 'https://example.com/x', 'text/html');
  });
});
