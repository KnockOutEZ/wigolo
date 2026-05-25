import type { WatchJobInput, WatchJobOutput, StageResult } from '../types.js';

/**
 * Slice A1 stub — registers the `watch` MCP surface so dependent slices can
 * fan out in parallel without contending on `src/server.ts`. The real
 * scheduler + persistent store land in slice B3 (see
 * docs/superpowers/specs/2026-05-26-webclaw-gap-closure-design.md §5 B3)
 * along with migration `src/cache/migrations/004-watch-jobs.sql`.
 *
 * Lazy execution is intentional: no background daemon. Checks fire when
 * `watch({action:'check'})` is called or when any other tool runs and the
 * job's `last_check_at + interval` has elapsed.
 */
export async function handleWatch(
  _input: Record<string, unknown> | WatchJobInput,
): Promise<StageResult<WatchJobOutput>> {
  return {
    ok: true,
    data: {
      jobs: [],
      notice: 'not_implemented_yet',
      slice: 'B3',
    },
  };
}
