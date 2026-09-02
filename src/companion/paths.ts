/**
 * The ONE definition of where this product keeps its on-disk state.
 *
 * `~/.wigolo` is the SHARED data dir — the cache DB, the vector index, the keys and every product's
 * state live under it. Five modules independently spelled `join(dataDir, 'studio', …)`, which is the
 * shape of the failure where a second product's output lands in the first product's directory: with
 * the segment repeated per call site there is no single place that decides who owns what.
 *
 * The PATH IS UNCHANGED (`~/.wigolo/studio/`). Nothing on disk moves, so an existing profile store,
 * handoff ledger, escalation ledger, snapshot spill or session handle keeps resolving exactly as
 * before. This is a definition being centralised, not a relocation.
 */
import { join } from 'node:path';
import { getConfig } from '../config.js';

/** The directory segment this product owns beneath the shared data dir. */
const STATE_DIR_SEGMENT = 'studio';

/**
 * This product's state directory beneath `dataDir` (defaulting to the configured shared data dir).
 * Pass `...segments` for a file or subdirectory within it.
 */
export function studioStateDir(dataDir?: string, ...segments: string[]): string {
  return join(dataDir ?? getConfig().dataDir, STATE_DIR_SEGMENT, ...segments);
}
