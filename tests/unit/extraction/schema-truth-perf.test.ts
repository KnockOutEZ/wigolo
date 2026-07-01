/**
 * Perf regression for schema-truth evidence filter.
 *
 * Why this matters:
 *   `src/extraction/schema-truth.ts` line 37 explicitly states:
 *
 *     "Cached at the call boundary; re-computing per field would be O(N*HTML)."
 *
 *   The original `applyEvidenceFilter` violated its own contract: it looped
 *   `input.fields` and called `verifyAgainstSource(v, input.sourceText)` per
 *   field, and `verifyAgainstSource` re-normalized the full sourceText on
 *   every invocation. For a 100 KB source with 20 schema fields the slice
 *   did 20 x full-text `.toLowerCase().replace(/\s+/g, ' ').trim()`.
 *
 *   This test encodes the contract — the source-side normalization must
 *   happen ONCE per `applyEvidenceFilter` call, regardless of field count.
 *   If a future change reintroduces per-field source normalization, this
 *   test fails.
 *
 * How:
 *   Spy on `String.prototype.toLowerCase`. The big-source call has a huge
 *   argument length (~the size of sourceText); per-value calls have small
 *   argument lengths (the length of each LLM-returned value string). We
 *   assert that "large" `.toLowerCase()` calls (> 10 KB) happen at most
 *   once per `applyEvidenceFilter` invocation, NOT once per field.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyEvidenceFilter } from '../../../src/extraction/schema-truth.js';

describe('schema-truth perf — applyEvidenceFilter source normalization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('evidence filter normalizes source once per call, not per field', () => {
    // Contract from schema-truth.ts line 37:
    //   "Cached at the call boundary; re-computing per field would be O(N*HTML)."
    // A regression would be `applyEvidenceFilter` calling normalize(sourceText)
    // for each field. We detect that by counting `.toLowerCase()` calls
    // whose receiver is a "large" string (the haystack).

    // 200 KB source. The actual content matters less than the size — we just
    // need it big enough that per-field re-normalization would be visibly bad.
    const sourceText = ('the quick brown fox jumped over the lazy dog. ' as string).repeat(
      4400,
    );
    expect(sourceText.length).toBeGreaterThan(200_000);

    // 20 fields. None present in source → all rejected (path doesn't matter,
    // we're measuring source-side work, not branch outcome).
    const N = 20;
    const fields = Array.from({ length: N }, (_, i) => `field_${i}`);
    const values: Record<string, unknown> = {};
    for (const f of fields) values[f] = `value_for_${f}`;

    const LARGE_THRESHOLD = 10_000; // anything over this is the haystack
    let largeLowerCaseCalls = 0;
    const realToLowerCase = String.prototype.toLowerCase;
    const spy = vi
      .spyOn(String.prototype, 'toLowerCase')
      .mockImplementation(function (this: string) {
        if (this.length >= LARGE_THRESHOLD) largeLowerCaseCalls++;
        return realToLowerCase.call(this);
      });

    applyEvidenceFilter({
      values,
      provenance: {},
      sourceText,
      fields,
    });

    spy.mockRestore();

    // The contract: large-source normalization runs ONCE per call, not N
    // times. We allow up to 2 to absorb any incidental large-string lowercase
    // elsewhere in the chain (e.g. an internal `String(value)` edge case),
    // but it must NOT scale with field count.
    expect(largeLowerCaseCalls).toBeLessThanOrEqual(2);
    expect(largeLowerCaseCalls).toBeLessThan(N);
  });

  it('completes 20-field filter on a 200 KB source well under 50 ms (sanity)', () => {
    // Time-bound sanity check. Pre-fix, 20 fields x 200 KB normalize would
    // stall visibly. Post-fix it should be effectively instantaneous.
    const sourceText = ('lorem ipsum dolor sit amet, consectetur adipiscing elit. ' as string).repeat(
      3700,
    );
    expect(sourceText.length).toBeGreaterThan(200_000);

    const N = 20;
    const fields = Array.from({ length: N }, (_, i) => `field_${i}`);
    const values: Record<string, unknown> = {};
    for (const f of fields) values[f] = `value_${f}_not_in_source`;

    const start = performance.now();
    applyEvidenceFilter({ values, provenance: {}, sourceText, fields });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
  });
});
