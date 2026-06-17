/**
 * Token-budget spill — the TRANSPORT layer, applied AFTER the (budget-independent)
 * diff. Content-addressed: an over-budget payload is written to a file under the
 * studio data dir and replaced inline by a `spill:<hash>` ref.
 *
 * Two properties keep a spilled snapshot actionable (build-in #4):
 *  - the FULL element set is spilled, so spilled elements keep their refs and the
 *    agent can address them for an action after fetching — not just read them;
 *  - the inline subset is the top-RANKED elements (document order as the relevance
 *    proxy; a viewport-relevance rank can slot in later), so the actionable head
 *    stays inline and the agent does not have to fetch the spill every turn.
 *
 * An over-budget diff (a big change or a navigation's full payload) spills too.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../../config.js';
import { countTokens } from '../../search/tokens.js';
import { hash } from './id.js';
import type { SnapshotElement } from './snapshot.js';
import type { SnapshotDiff } from './diff.js';

function spillDir(dataDir?: string): string {
  return join(dataDir ?? getConfig().dataDir, 'studio', 'snapshots');
}

/** Write a payload to the content-addressed spill store; returns a `spill:<hash>` ref. */
export function writeSpill(payload: unknown, dataDir?: string): string {
  const json = JSON.stringify(payload);
  const h = hash(json);
  const dir = spillDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${h}.json`), json, { mode: 0o600 });
  return 'spill:' + h;
}

/** Resolve a `spill:<hash>` ref. Returns null on unknown/garbage refs; rejects path traversal in the ref. */
export function readSpill(ref: string, dataDir?: string): unknown | null {
  if (typeof ref !== 'string' || !ref.startsWith('spill:')) return null;
  const h = ref.slice('spill:'.length);
  if (!/^[0-9a-z]+$/.test(h)) return null; // hash chars only — no separators, no traversal
  const p = join(spillDir(dataDir), `${h}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

const SPILL_REF_RESERVE = 16; // leave room for the spill-ref marker in the inline payload

export interface FitResult {
  elements: SnapshotElement[];
  spillRef: string | null;
  spilled: number;
  tokenCount: number;
}

/** Keep the top-ranked elements inline within budget; spill the remainder. The FULL set is written, so spilled elements stay addressable. */
export function fitElementsToBudget(elements: SnapshotElement[], budget: number, dataDir?: string): FitResult {
  const full = countTokens(JSON.stringify(elements));
  if (full <= budget) return { elements, spillRef: null, spilled: 0, tokenCount: full };
  const inline: SnapshotElement[] = [];
  let used = 0;
  for (const e of elements) {
    const t = countTokens(JSON.stringify(e));
    if (used + t > budget - SPILL_REF_RESERVE) break;
    inline.push(e);
    used += t;
  }
  const spillRef = writeSpill(elements, dataDir); // the full set — spilled elements keep their refs
  return { elements: inline, spillRef, spilled: elements.length - inline.length, tokenCount: countTokens(JSON.stringify(inline)) };
}

export interface DiffFitResult {
  diff: SnapshotDiff | null;
  summary?: { added: number; removed: number; churn: number; changed: number };
  spillRef: string | null;
}

/** A diff that itself blows the budget (big change / navigation) spills whole; a small counts summary stays inline. */
export function fitDiffToBudget(diff: SnapshotDiff, budget: number, dataDir?: string): DiffFitResult {
  if (countTokens(JSON.stringify(diff)) <= budget) return { diff, spillRef: null };
  return {
    diff: null,
    summary: {
      added: diff.added.length,
      removed: diff.removed.length,
      churn: diff.lowConfidenceChurn.added.length + diff.lowConfidenceChurn.removed.length,
      changed: diff.changed.length,
    },
    spillRef: writeSpill(diff, dataDir),
  };
}
