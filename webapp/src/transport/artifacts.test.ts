import { describe, it, expect } from 'vitest';
import { ArtifactsModel } from './artifacts.js';

/**
 * The captured-items list reducer (7e S3). It holds the SERVER-authoritative set of captured artifacts
 * (clips/qa): it changes ONLY when the host speaks — the post-hello `artifact_snapshot` (the complete truth →
 * replace) or a live `artifact` delta (upsert by id, so a re-broadcast of the same captured item never
 * double-adds). No optimistic/local add — mirrors MarksModel / CommentsModel.
 */
describe('ArtifactsModel — server-authoritative captured-items list', () => {
  const item = (over: Partial<{ id: number; type: string; title: string; url: string; trusted: boolean; created_at: string }> = {}) => ({
    id: over.id ?? 1,
    type: over.type ?? 'clip',
    title: over.title ?? 'clip 1',
    url: over.url ?? 'https://x.example/1',
    trusted: over.trusted ?? false,
    created_at: over.created_at ?? '2026-06-24T00:00:00.000Z',
  });

  it('applies a live delta, upserting by id (new appends, a repeat id replaces in place)', () => {
    const model = new ArtifactsModel();
    model.applyDelta(item({ id: 1, title: 'first' }));
    model.applyDelta(item({ id: 2, title: 'second' }));
    model.applyDelta(item({ id: 1, title: 'first (re-broadcast)' })); // dedup re-broadcast of the same item
    expect(model.snapshot().map((i) => [i.id, i.title])).toEqual([[1, 'first (re-broadcast)'], [2, 'second']]);
  });

  it('empty until the server speaks (no optimistic local add)', () => {
    const model = new ArtifactsModel();
    expect(model.snapshot()).toEqual([]);
    model.applyDelta(item({ id: 5 }));
    expect(model.snapshot().map((i) => i.id)).toEqual([5]);
  });

  // PIN-C (authoritative snapshot — replace, never merge). NAMED mutation that REDs: make applySnapshot MERGE
  // (append) instead of REPLACE → a stale item the host omitted survives a fresh snapshot.
  it('PIN-C: a snapshot is the complete truth — replaces, never merges (a stale item does not survive)', () => {
    const model = new ArtifactsModel();
    model.applyDelta(item({ id: 1, title: 'stale' }));
    model.applyDelta(item({ id: 2, title: 'also stale' }));
    expect(model.snapshot().map((i) => i.id)).toEqual([1, 2]);
    model.applySnapshot([item({ id: 2, title: 'fresh' })]); // the host's COMPLETE set — id 1 omitted
    expect(model.snapshot().map((i) => i.id)).toEqual([2]); // id 1 gone — authoritative replace
    expect(model.snapshot()[0].title).toBe('fresh');
  });

  it('notifies subscribers on snapshot and delta', () => {
    const model = new ArtifactsModel();
    let n = 0;
    const off = model.subscribe(() => n++);
    model.applySnapshot([item({ id: 1 })]);
    model.applyDelta(item({ id: 2 }));
    expect(n).toBe(2);
    off();
    model.applyDelta(item({ id: 3 }));
    expect(n).toBe(2); // unsubscribed
  });
});
