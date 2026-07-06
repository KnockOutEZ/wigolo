import { describe, it, expect } from 'vitest';
import { createCapturesStore } from '../../src/renderer/captures-store';
import type { CaptureDto } from '../../src/shared/ipc';

const dto = (id: number, createdAt = '2026-07-07T00:00:00.000Z', type = 'clip'): CaptureDto =>
  ({ id, type, title: `item ${id}`, url: `https://ex.com/${id}`, trusted: false, createdAt });

describe('captures-store — renderer captures state', () => {
  it('starts empty', () => {
    expect(createCapturesStore().list()).toEqual([]);
  });

  it('set() replaces the full set; list is newest-first', () => {
    const s = createCapturesStore();
    s.set([dto(1, '2026-07-07T00:00:01.000Z'), dto(2, '2026-07-07T00:00:02.000Z')]);
    expect(s.list().map((c) => c.id)).toEqual([2, 1]);
  });

  it('add() appends a live delta and dedups by id (no double-list)', () => {
    const s = createCapturesStore();
    s.set([dto(1)]);
    s.add(dto(2, '2026-07-07T00:00:03.000Z'));
    expect(s.list().map((c) => c.id)).toEqual([2, 1]);
    s.add(dto(2, '2026-07-07T00:00:03.000Z')); // same id again — ignored
    expect(s.list()).toHaveLength(2);
  });

  it('notifies subscribers on set and add', () => {
    const s = createCapturesStore();
    let n = 0;
    s.subscribe(() => { n++; });
    s.set([dto(1)]);
    s.add(dto(2));
    expect(n).toBe(2);
  });
});
