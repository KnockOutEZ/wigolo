import { describe, it, expect, vi } from 'vitest';
import { TimelineModel } from './timeline.js';
import type { AuditView } from './codec.js';

const entry = (seq: number, over: Partial<AuditView> = {}): AuditView => ({
  seq,
  ts: 1000 + seq,
  action: 'navigate',
  epoch: 0,
  outcome: { ok: true },
  ...over,
});

/**
 * Client holder of the SERVER-authoritative audit timeline (7d S4). The host owns the truth: the post-hello
 * {t:'audit_snapshot'} REPLACES the list (authoritative backfill) and each live {t:'audit'} delta APPENDS.
 * There is NO optimistic local entry — the client never shows an action the host did not record.
 */
describe('TimelineModel — server-authoritative audit timeline', () => {
  it('is empty until the server feeds it (no optimistic local entry)', () => {
    expect(new TimelineModel().snapshot()).toEqual([]);
  });

  it('applyDelta appends entries in arrival order', () => {
    const m = new TimelineModel();
    m.applyDelta(entry(1, { action: 'navigate' }));
    m.applyDelta(entry(2, { action: 'click' }));
    expect(m.snapshot().map((e) => e.seq)).toEqual([1, 2]);
    expect(m.snapshot().map((e) => e.action)).toEqual(['navigate', 'click']);
  });

  // PIN-B (authoritative snapshot — replace, NOT merge). A fresh backfill is the host's complete truth; a
  // stale entry from before it must NOT survive. NAMED mutation that REDs: make applySnapshot merge/append
  // onto the existing list instead of replacing → the stale entry (seq 9) lingers after a fresh snapshot.
  it('PIN-B: applySnapshot REPLACES the list — a stale prior entry does not survive a fresh snapshot', () => {
    const m = new TimelineModel();
    m.applySnapshot([entry(9, { action: 'stale-old' })]);
    expect(m.snapshot().map((e) => e.seq)).toEqual([9]);
    m.applySnapshot([entry(51), entry(52)]); // a fresh authoritative backfill
    expect(m.snapshot().map((e) => e.seq)).toEqual([51, 52]); // the stale seq 9 is gone — replaced, not merged
  });

  it('notifies subscribers on snapshot and on delta', () => {
    const m = new TimelineModel();
    const cb = vi.fn();
    m.subscribe(cb);
    m.applySnapshot([entry(1)]);
    m.applyDelta(entry(2));
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
