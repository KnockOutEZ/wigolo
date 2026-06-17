/**
 * Incremental snapshot diff for `studio_observe`. Two invariants matter:
 *
 *  - It is SEMANTIC — computed over the full logical element set, ID-keyed, and
 *    INDEPENDENT of the token budget. Spill is a separate transport step applied
 *    afterward, so an element crossing the budget boundary between turns never shows
 *    up as a phantom add/remove.
 *  - It must NOT amplify 2E's one weakness into a false structural claim. An
 *    identical-sibling run that reorders drifts its positional refs (the 1/5 case);
 *    diff-by-ref would read that as N removes + N adds. Instead, refs that share a
 *    fingerprint group on BOTH sides are folded into `lowConfidenceChurn` — flagged
 *    ambiguous, so neither the agent nor 2J acts on a fabricated delta.
 *
 * Every diff is tagged with the base snapshot id it was computed against;
 * `resolveObserve` falls back to a full snapshot when the consumer's held base does
 * not match (reconnect / restart / proxy desync) or after a navigation — never a
 * delta against an unknown base.
 */
import type { PageSnapshot, SnapshotElement } from './snapshot.js';

export interface SnapshotDiff {
  /** The prev snapshot id this delta is valid against. */
  baseId: string;
  /** The resulting snapshot id (the consumer's new base after applying). */
  id: string;
  added: SnapshotElement[];
  removed: SnapshotElement[];
  /** Same ref, changed value/state. Empty in the current lean shape (ref encodes role+name); kept for forward-compat. */
  changed: SnapshotElement[];
  /** Identical-sibling positional drift — NOT structural. Folded out of add/remove so it is never presented as a confident delta. */
  lowConfidenceChurn: { groups: string[]; added: SnapshotElement[]; removed: SnapshotElement[] };
}

export function diffSnapshots(prev: PageSnapshot, next: PageSnapshot): SnapshotDiff {
  const prevByRef = new Map(prev.elements.map((e) => [e.ref, e]));
  const nextByRef = new Map(next.elements.map((e) => [e.ref, e]));

  const removedRaw = prev.elements.filter((e) => !nextByRef.has(e.ref));
  const addedRaw = next.elements.filter((e) => !prevByRef.has(e.ref));
  // Same ref ⇒ same role+name (ref encodes them), so "changed" is empty today; computed defensively.
  const changed = next.elements.filter((e) => {
    const p = prevByRef.get(e.ref);
    return p && JSON.stringify(p) !== JSON.stringify(e);
  });

  // Fold identical-sibling positional drift into churn: a removed low-confidence ref
  // and an added low-confidence ref that share a fingerprint group present on BOTH
  // sides are the SAME logical run reordering, not a structural change.
  const removedGroups = new Set(removedRaw.filter((e) => e.confidence === 'low').map((e) => prev.groupByRef.get(e.ref)).filter((g): g is string => !!g));
  const addedGroups = new Set(addedRaw.filter((e) => e.confidence === 'low').map((e) => next.groupByRef.get(e.ref)).filter((g): g is string => !!g));
  const churnGroups = [...removedGroups].filter((g) => addedGroups.has(g));
  const churnSet = new Set(churnGroups);

  const churnRemoved = removedRaw.filter((e) => e.confidence === 'low' && churnSet.has(prev.groupByRef.get(e.ref) ?? ''));
  const churnAdded = addedRaw.filter((e) => e.confidence === 'low' && churnSet.has(next.groupByRef.get(e.ref) ?? ''));
  const churnRemovedSet = new Set(churnRemoved);
  const churnAddedSet = new Set(churnAdded);

  return {
    baseId: prev.id,
    id: next.id,
    removed: removedRaw.filter((e) => !churnRemovedSet.has(e)),
    added: addedRaw.filter((e) => !churnAddedSet.has(e)),
    changed,
    lowConfidenceChurn: { groups: churnGroups, removed: churnRemoved, added: churnAdded },
  };
}

export type ObserveResult =
  | { kind: 'full'; snapshot: PageSnapshot; reason: 'no_base' | 'base_mismatch' | 'navigated' }
  | { kind: 'diff'; diff: SnapshotDiff };

/**
 * Decide whether the consumer gets a delta or a full resync. A delta is valid ONLY
 * against the exact base it holds; on any desync (no base / mismatch / navigation)
 * send a full snapshot and reset the base — never a delta against an unknown page.
 */
export function resolveObserve(
  prev: PageSnapshot | null,
  next: PageSnapshot,
  opts: { heldBaseId?: string; navigated?: boolean },
): ObserveResult {
  if (!prev) return { kind: 'full', snapshot: next, reason: 'no_base' };
  if (opts.navigated) return { kind: 'full', snapshot: next, reason: 'navigated' };
  if (opts.heldBaseId !== prev.id) return { kind: 'full', snapshot: next, reason: 'base_mismatch' };
  return { kind: 'diff', diff: diffSnapshots(prev, next) };
}
