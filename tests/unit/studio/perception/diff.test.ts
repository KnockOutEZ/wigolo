import { describe, it, expect } from 'vitest';
import { diffSnapshots, resolveObserve } from '../../../../src/studio/perception/diff.js';
import type { PageSnapshot, SnapshotElement } from '../../../../src/studio/perception/snapshot.js';

function sn(id: string, els: SnapshotElement[], groups: Record<string, string> = {}, over = false): PageSnapshot {
  return { id, elements: els, tokenCount: 0, overBudget: over, domTruncated: false, refMap: new Map(), groupByRef: new Map(Object.entries(groups)) };
}
const el = (ref: string, name: string, confidence?: 'low'): SnapshotElement => (confidence ? { ref, role: 'button', name, confidence } : { ref, role: 'button', name });

describe('diffSnapshots — semantic diff, ID-keyed, over the FULL element set', () => {
  it('no change → empty add/remove/changed, tagged with base + next id', () => {
    const d = diffSnapshots(sn('s1', [el('e1', 'Open'), el('e2', 'Save')]), sn('s2', [el('e1', 'Open'), el('e2', 'Save')]));
    expect(d).toMatchObject({ baseId: 's1', id: 's2', added: [], removed: [], changed: [] });
    expect(d.lowConfidenceChurn).toEqual({ groups: [], added: [], removed: [] });
  });

  it('real structural change → high-confidence add/remove', () => {
    const d = diffSnapshots(sn('s1', [el('e1', 'Open')]), sn('s2', [el('e2', 'Close')]));
    expect(d.removed.map((e) => e.ref)).toEqual(['e1']);
    expect(d.added.map((e) => e.ref)).toEqual(['e2']);
  });

  it('identical-sibling positional drift → low-confidence CHURN, NOT phantom add/remove (build-in #1)', () => {
    const a = sn('s1', [el('eA', 'Delete', 'low'), el('eB', 'Delete', 'low')], { eA: 'gD', eB: 'gD' });
    const b = sn('s2', [el('eC', 'Delete', 'low'), el('eD', 'Delete', 'low')], { eC: 'gD', eD: 'gD' });
    const d = diffSnapshots(a, b);
    expect(d.added).toEqual([]); // NOT "2 appeared"
    expect(d.removed).toEqual([]); // NOT "2 deleted"
    expect(d.lowConfidenceChurn.groups).toEqual(['gD']);
    expect(d.lowConfidenceChurn.removed.map((e) => e.ref).sort()).toEqual(['eA', 'eB']);
    expect(d.lowConfidenceChurn.added.map((e) => e.ref).sort()).toEqual(['eC', 'eD']);
  });

  it('separates a genuine add from low-confidence churn in the same diff', () => {
    const a = sn('s1', [el('eA', 'Delete', 'low'), el('eB', 'Delete', 'low'), el('hold', 'Keep')], { eA: 'gD', eB: 'gD' });
    const b = sn('s2', [el('eC', 'Delete', 'low'), el('eD', 'Delete', 'low'), el('hold', 'Keep'), el('new', 'Added')], { eC: 'gD', eD: 'gD' });
    const d = diffSnapshots(a, b);
    expect(d.added.map((e) => e.ref)).toEqual(['new']); // the genuine add surfaces as real
    expect(d.removed).toEqual([]);
    expect(d.lowConfidenceChurn.added.map((e) => e.ref).sort()).toEqual(['eC', 'eD']);
  });

  it('is budget-INDEPENDENT: shared elements never add/remove across the 4000 boundary, while a real remove still surfaces (build-in #3)', () => {
    const a = sn('s1', [el('keep1', 'Stay 1'), el('keep2', 'Stay 2'), el('gone', 'Removed')], {}, false); // under budget
    const b = sn('s2', [el('keep1', 'Stay 1'), el('keep2', 'Stay 2'), el('more', 'Extra')], {}, true); // over budget
    const d = diffSnapshots(a, b);
    expect(d.removed.map((e) => e.ref)).toEqual(['gone']); // the GENUINE removal still surfaces (remove path works)
    expect(d.added.map((e) => e.ref)).toEqual(['more']); // only the genuine add
    // Neither shared element is phantom-churned by next crossing the budget boundary:
    expect(d.removed.map((e) => e.ref)).not.toContain('keep1');
    expect(d.removed.map((e) => e.ref)).not.toContain('keep2');
  });
});

describe('resolveObserve — base-version tag + full-resync fallback', () => {
  const a = sn('s1', [el('e1', 'Open')]);
  const b = sn('s2', [el('e1', 'Open'), el('e2', 'Save')]);

  it('no prior base → full snapshot (no_base)', () => {
    expect(resolveObserve(null, b, {})).toMatchObject({ kind: 'full', reason: 'no_base' });
  });
  it('held base matches prev → diff against that base', () => {
    const r = resolveObserve(a, b, { heldBaseId: 's1' });
    expect(r.kind).toBe('diff');
    if (r.kind === 'diff') expect(r.diff.baseId).toBe('s1');
  });
  it('held base MISMATCHES prev (reconnect/desync) → full resync, never a delta on an unknown base (build-in #2)', () => {
    expect(resolveObserve(a, b, { heldBaseId: 'stale-from-old-connection' })).toMatchObject({ kind: 'full', reason: 'base_mismatch' });
  });
  it('navigation → full snapshot + new base, never a diff against the page you just left (build-in #5)', () => {
    expect(resolveObserve(a, b, { heldBaseId: 's1', navigated: true })).toMatchObject({ kind: 'full', reason: 'navigated' });
  });
});
