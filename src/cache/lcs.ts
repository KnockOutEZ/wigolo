/**
 * Shared LCS DP table for diff-engine + diff-summary.
 *
 * Uses a single packed `Uint16Array` of size (m+1) * (n+1). Indexed as
 * `i * (n + 1) + j`. LCS length is bounded by `Math.min(m, n)`; the diff
 * modules cap inputs at 5000 lines which fits comfortably in 16 bits.
 *
 * Why packed: the prior 2D JS array allocates (m+1) sub-arrays of boxed
 * numbers — at 5000-cap that's 25M boxed values across 5001 arrays. A
 * single Uint16Array is ~8x faster on the same shape and far easier on GC.
 */
export function computeLcsTable(oldLines: string[], newLines: string[]): Uint16Array {
  const m = oldLines.length;
  const n = newLines.length;
  const stride = n + 1;
  const dp = new Uint16Array((m + 1) * stride);

  for (let i = 1; i <= m; i++) {
    const oi = oldLines[i - 1];
    const rowBase = i * stride;
    const prevRowBase = rowBase - stride;
    for (let j = 1; j <= n; j++) {
      if (oi === newLines[j - 1]) {
        dp[rowBase + j] = dp[prevRowBase + (j - 1)] + 1;
      } else {
        const up = dp[prevRowBase + j];
        const left = dp[rowBase + (j - 1)];
        dp[rowBase + j] = up >= left ? up : left;
      }
    }
  }
  return dp;
}

/** Index helper kept inline-able for hot loops, but exported for callers that prefer it. */
export function lcsAt(dp: Uint16Array, i: number, j: number, stride: number): number {
  return dp[i * stride + j];
}
