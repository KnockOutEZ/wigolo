import { describe, it, expect } from 'vitest';
import { createApprovalStore } from '../../src/renderer/approval-store';

describe('approval-store — placeholder approval state (never auto-allows)', () => {
  it('starts empty', () => {
    const store = createApprovalStore();
    expect(store.pending()).toEqual([]);
  });

  it('add surfaces a parked action; duplicate ids do not double-add', () => {
    const store = createApprovalStore();
    store.add({ id: 'a1', action: 'navigate', risk: 'money' });
    store.add({ id: 'a1', action: 'navigate', risk: 'money' });
    expect(store.pending()).toHaveLength(1);
    expect(store.pending()[0]).toMatchObject({ id: 'a1', action: 'navigate', risk: 'money' });
  });

  it('decide(allow) removes the item and yields the allow decision to emit', () => {
    const store = createApprovalStore();
    store.add({ id: 'a1', action: 'click', risk: 'destructive' });
    const decision = store.decide('a1', 'allow');
    expect(decision).toEqual({ id: 'a1', decision: 'allow' });
    expect(store.pending()).toEqual([]);
  });

  it('decide(deny) removes the item and yields deny', () => {
    const store = createApprovalStore();
    store.add({ id: 'a1', action: 'click', risk: 'money' });
    expect(store.decide('a1', 'deny')).toEqual({ id: 'a1', decision: 'deny' });
    expect(store.pending()).toEqual([]);
  });

  it('deciding an unknown id is a no-op (returns null, pending untouched)', () => {
    const store = createApprovalStore();
    store.add({ id: 'a1', action: 'click', risk: 'money' });
    expect(store.decide('nope', 'allow')).toBeNull();
    expect(store.pending()).toHaveLength(1);
  });

  it('NEGATIVE GUARD: an allow decision is emitted ONLY via an explicit decide(_, "allow") — never auto-resolved', () => {
    const store = createApprovalStore();
    const emitted: Array<{ id: string; decision: string }> = [];
    store.onDecision((d) => emitted.push(d));
    store.add({ id: 'a1', action: 'pay', risk: 'money' });
    store.add({ id: 'a2', action: 'delete', risk: 'destructive' });
    // No decide() calls yet → nothing may have been emitted (no timeout/auto path).
    expect(emitted).toEqual([]);
    store.decide('a1', 'deny');
    expect(emitted).toEqual([{ id: 'a1', decision: 'deny' }]);
    // a2 stays pending until an explicit decision; it is never silently allowed.
    expect(store.pending().map((p) => p.id)).toEqual(['a2']);
  });
});
