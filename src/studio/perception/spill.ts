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
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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
  /** Tokens of the INLINE payload (the diff when it fits, else the counts summary). */
  tokenCount: number;
}

export interface SpillGcResult {
  evicted: number;
  bytes: number;
}

/**
 * Bound the content-addressed spill dir by TOTAL BYTES (it holds PNG screenshots from
 * 2G, far larger than text snapshots — a count cap is insufficient). REFERENCE-AWARE:
 * a ref in `protect` (one a live snapshot/diff/vision still points at) is NEVER evicted,
 * even if it is the oldest. Eviction is oldest-mtime-first among the unprotected. A
 * later fetch of an evicted ref returns null (the caller must surface that fail-loud,
 * never silently return nothing).
 */
export function enforceSpillBudget(opts: { maxBytes: number; protect?: ReadonlySet<string>; dataDir?: string }): SpillGcResult {
  const dir = spillDir(opts.dataDir);
  let files: Array<{ name: string; ref: string; size: number; mtimeMs: number }>;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const st = statSync(join(dir, f));
        return { name: f, ref: 'spill:' + f.slice(0, -'.json'.length), size: st.size, mtimeMs: st.mtimeMs };
      });
  } catch {
    return { evicted: 0, bytes: 0 }; // dir absent → nothing to GC
  }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  const protect = opts.protect ?? new Set<string>();
  const evictable = files.filter((f) => !protect.has(f.ref)).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let evicted = 0;
  for (const f of evictable) {
    if (total <= opts.maxBytes) break;
    try {
      unlinkSync(join(dir, f.name));
      total -= f.size;
      evicted += 1;
    } catch {
      /* already gone — ignore */
    }
  }
  return { evicted, bytes: total };
}

/** A diff that itself blows the budget (big change / navigation) spills whole; a small counts summary stays inline. */
export function fitDiffToBudget(diff: SnapshotDiff, budget: number, dataDir?: string): DiffFitResult {
  const diffTokens = countTokens(JSON.stringify(diff));
  if (diffTokens <= budget) return { diff, spillRef: null, tokenCount: diffTokens };
  const summary = {
    added: diff.added.length,
    removed: diff.removed.length,
    churn: diff.lowConfidenceChurn.added.length + diff.lowConfidenceChurn.removed.length,
    changed: diff.changed.length,
  };
  return {
    diff: null,
    summary,
    spillRef: writeSpill(diff, dataDir),
    tokenCount: countTokens(JSON.stringify(summary)),
  };
}
