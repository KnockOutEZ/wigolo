import { describe, it, expect } from 'vitest';
import { MarksModel } from './marks.js';

/**
 * The marks list reducer (7c S4). It holds the SERVER-authoritative set of human marks: it changes ONLY when
 * the host speaks — the post-hello `marks_snapshot` (the complete truth → replace) or a live `mark` delta
 * (upsert by id). There is no optimistic/local add: the client never invents a mark the server didn't send.
 */
describe('MarksModel — server-authoritative marks list', () => {
  it('applies a live delta as an upsert by markId (new appends, repeat replaces in place)', () => {
    const model = new MarksModel();
    model.applyDelta({ markId: 'm1', role: 'button', name: 'Add', confidence: 'high' });
    model.applyDelta({ markId: 'm1', role: 'button', name: 'Add', confidence: 'medium' }); // re-heal of the same mark
    expect(model.snapshot()).toEqual([{ markId: 'm1', role: 'button', name: 'Add', confidence: 'medium' }]);
  });

  // PIN-B (no optimistic add — the reducer is server-authoritative). NAMED mutation that REDs: seed the model
  // with a pre-message entry (or make applySnapshot MERGE instead of REPLACE) → the list shows a mark the
  // server never sent. The empty-before-any-message and the snapshot-replaces assertions both catch it.
  it('PIN-B: empty until the server speaks, and a snapshot is the complete truth (replaces, never merges)', () => {
    const model = new MarksModel();
    expect(model.snapshot()).toEqual([]); // nothing optimistic before any server message
    model.applyDelta({ markId: 'm1', role: 'button', name: 'A', confidence: 'high' });
    model.applyDelta({ markId: 'm2', role: 'link', name: 'B', confidence: 'low' });
    expect(model.snapshot().map((m) => m.markId)).toEqual(['m1', 'm2']);
    // the backfill snapshot is the host's COMPLETE set → it replaces; an entry the host omits disappears.
    model.applySnapshot([{ markId: 'm2', role: 'link', name: 'B', confidence: 'medium' }]);
    expect(model.snapshot().map((m) => m.markId)).toEqual(['m2']); // m1 gone — authoritative replace, not merge
    expect(model.snapshot()[0].confidence).toBe('medium'); // and m2 takes the snapshot's value
  });

  it('notifies subscribers on snapshot and delta', () => {
    const model = new MarksModel();
    let n = 0;
    const off = model.subscribe(() => n++);
    model.applySnapshot([{ markId: 'm1', role: 'button', name: 'A', confidence: 'high' }]);
    model.applyDelta({ markId: 'm2', role: 'link', name: 'B', confidence: 'low' });
    expect(n).toBe(2);
    off();
    model.applyDelta({ markId: 'm3', role: 'img', name: 'C', confidence: 'none' });
    expect(n).toBe(2); // unsubscribed
  });
});
