import type { DiffOutput, WatchJobInput, StageResult } from '../types.js';

/**
 * Slice A1 stub — registers the `diff` MCP surface so dependent slices can
 * fan out in parallel without contending on `src/server.ts`. The real diff
 * engine lands in slice B1 (see docs/superpowers/specs/2026-05-26-webclaw-
 * gap-closure-design.md §5 B1) and will delegate to a new
 * `src/cache/diff-engine.ts` that reuses the existing LCS in
 * `src/cache/diff-summary.ts` plus its size-cap fallback.
 *
 * The handler accepts (and ignores) the future input shape so a B1 PR can
 * land without touching the dispatch chain again.
 */
export async function handleDiff(
  _input: Record<string, unknown> | WatchJobInput,
): Promise<StageResult<DiffOutput>> {
  return {
    ok: true,
    data: {
      changed: false,
      notice: 'not_implemented_yet',
      slice: 'B1',
    },
  };
}
