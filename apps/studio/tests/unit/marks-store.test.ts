import { describe, it, expect } from 'vitest';
import { createMarksStore } from '../../src/renderer/marks-store';
import type { MarkDto } from '../../src/shared/ipc';

const dto = (markId: string, name = 'Buy', confidence: MarkDto['confidence'] = 'high'): MarkDto =>
  ({ markId, role: 'button', name, confidence, ref: 'e1' });

describe('marks-store — renderer marks state (mirrors approval-store pattern)', () => {
  it('starts empty', () => {
    expect(createMarksStore().list()).toEqual([]);
  });

  it('set() replaces the mark set from the host push; new marks start with no comments', () => {
    const s = createMarksStore();
    s.set([dto('m1'), dto('m2', 'Choose')]);
    expect(s.list().map((m) => m.markId)).toEqual(['m1', 'm2']);
    expect(s.list()[0].comments).toEqual([]);
  });

  it('set() PRESERVES local comments across a heal-refresh push (same markId, new confidence)', () => {
    const s = createMarksStore();
    s.set([dto('m1', 'Buy', 'high')]);
    s.appendComment('m1', 'this is the CTA');
    s.set([dto('m1', 'Buy', 'low')]); // a re-push after DOM drift (confidence changed)
    const m = s.list()[0];
    expect(m.confidence).toBe('low'); // refreshed
    expect(m.comments).toEqual(['this is the CTA']); // comment survives the re-push
  });

  it('set() drops marks no longer present (host removed them)', () => {
    const s = createMarksStore();
    s.set([dto('m1'), dto('m2')]);
    s.set([dto('m1')]);
    expect(s.list().map((m) => m.markId)).toEqual(['m1']);
  });

  it('appendComment adds to a mark; unknown markId is a no-op', () => {
    const s = createMarksStore();
    s.set([dto('m1')]);
    s.appendComment('m1', 'a');
    s.appendComment('m1', 'b');
    s.appendComment('zz', 'ignored');
    expect(s.list()[0].comments).toEqual(['a', 'b']);
  });

  it('subscribers fire on set and on appendComment', () => {
    const s = createMarksStore();
    let n = 0;
    s.subscribe(() => { n++; });
    s.set([dto('m1')]);
    s.appendComment('m1', 'x');
    expect(n).toBe(2);
  });
});
