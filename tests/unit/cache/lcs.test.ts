import { describe, it, expect } from 'vitest';
import { computeLcsTable } from '../../../src/cache/lcs.js';

/**
 * WHY this matters (PR #89 sec+perf review):
 *
 * The shared LCS table was a `Uint16Array`. For inputs whose LCS length
 * could exceed 65535 (e.g. word-granularity diff over a long matching
 * prefix), the DP cell values silently wrapped at 16 bits — producing a
 * mathematically WRONG LCS with NO error and NO truncation signal. The
 * line-granularity path is bounded by `DIFF_LINE_CAP=5000`, but the word
 * path can blow past 65535 tokens. Switching to `Uint32Array` removes the
 * footgun outright.
 *
 * NOTE on testing strategy (option B): a direct end-to-end overflow proof
 * is mathematically infeasible. LCS length is bounded by `min(m, n)`, so a
 * cell value > 65535 requires BOTH sides longer than 65535. That makes the
 * DP table `>= 65536 * 65536 ≈ 4.3e9` cells, which exceeds `Uint32Array`'s
 * max length (`2^32 - 1`) and would need ~17 GB of memory. The original
 * test that allocated a 66001-by-66001 table is infeasible on every CI
 * runner (Linux/macOS/Windows) regardless of how much memory the host has.
 *
 * Instead, this suite pins the contract two ways — each test on its own
 * would let a `Uint16Array` regression through, but together they form a
 * tight ratchet:
 *
 *   1. STRUCTURAL: the returned table is a `Uint32Array` (4-byte elements,
 *      32-bit max range). A drop-in `Uint16Array` substitution fails this
 *      immediately because `Uint16Array.BYTES_PER_ELEMENT === 2`.
 *   2. BEHAVIOURAL: the table records LCS counts correctly on a feasible
 *      input — guards against a separate regression where the type is
 *      right but the DP recurrence is wrong (e.g. someone swaps `+ 1` for
 *      `+ 0` or breaks the max(up, left) tie).
 */
describe('computeLcsTable — Uint32Array bound (PR #89 sec+perf)', () => {
  it('returns a Uint32Array (structural proof the table can hold values > 65535)', () => {
    // A `Uint16Array` substitution in `lcs.ts` makes this assertion fail
    // outright (`BYTES_PER_ELEMENT === 2`, and it is not an instance of
    // Uint32Array). The check is intentionally narrow: pin Uint32Array so
    // any narrower replacement is caught, but don't over-specify (e.g.
    // BigUint64Array would also be safe and shouldn't fail this test).
    const dp = computeLcsTable(['a'], ['a']);
    expect(dp).toBeInstanceOf(Uint32Array);
    expect(dp.BYTES_PER_ELEMENT).toBe(4);
  });

  it('records LCS counts correctly on a feasible mid-sized matching input', () => {
    // Two identical sequences of 1024 tokens → LCS = 1024. This exercises
    // the DP recurrence end-to-end with a real table (1025*1025 = ~1M cells
    // = ~4 MB) — well within the < 100 MB / < 2s budget. The point is to
    // catch arithmetic regressions independently of the type-level proof.
    const SIZE = 1024;
    const seq = new Array(SIZE);
    for (let i = 0; i < SIZE; i++) seq[i] = `t${i % 7}`; // 7-symbol alphabet
    const dp = computeLcsTable(seq, seq);
    const stride = seq.length + 1;
    const finalCell = dp[seq.length * stride + seq.length];
    expect(finalCell).toBe(SIZE);
  });

  it('still returns correct LCS length for short sequences (regression coverage)', () => {
    const dp = computeLcsTable(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd']);
    // LCS = a, c, d → length 3.
    const stride = 5; // n+1 = 4+1
    expect(dp[4 * stride + 4]).toBe(3);
  });
});
