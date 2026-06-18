import { describe, it, expect } from 'vitest';
import { MarkStore } from '../../../src/studio/mark/store.js';
import type { StructuredTarget } from '../../../src/studio/mark/target.js';

const target = (name: string): StructuredTarget => ({
  backendNodeId: 1,
  role: 'button',
  name,
  trusted: false,
  fingerprint: 'fp-' + name,
  ancestorPath: 'body/div/button',
  attrs: {},
});

describe('MarkStore — in-memory session marks', () => {
  it('add() assigns a unique markId, stores the target, and returns the mark', () => {
    const store = new MarkStore();
    const m = store.add(target('Buy'));
    expect(m.markId).toBeTruthy();
    expect(m.target.name).toBe('Buy');
    expect(store.list()).toEqual([m]);
  });

  it('assigns distinct ids in insertion order and get() retrieves by id', () => {
    const store = new MarkStore();
    const a = store.add(target('A'));
    const b = store.add(target('B'));
    expect(a.markId).not.toBe(b.markId);
    expect(store.list().map((m) => m.markId)).toEqual([a.markId, b.markId]);
    expect(store.get(b.markId)?.target.name).toBe('B');
    expect(store.get('nope')).toBeUndefined();
  });

  it('list() returns a copy — mutating it does not corrupt the store', () => {
    const store = new MarkStore();
    store.add(target('A'));
    store.list().push({ markId: 'x', target: target('rogue') });
    expect(store.list()).toHaveLength(1);
  });
});
