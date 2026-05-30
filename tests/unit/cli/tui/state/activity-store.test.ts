import { describe, it, expect } from 'vitest';
import { createActivityStore } from '../../../../../src/cli/tui/state/activity-store.js';

describe('activity-store', () => {
  it('flips busy on begin/end balanced calls', () => {
    const store = createActivityStore();
    expect(store.busy()).toBe(false);
    const endA = store.begin('verify');
    expect(store.busy()).toBe(true);
    expect(store.labels()).toEqual(['verify']);
    const endB = store.begin('doctor');
    expect(store.labels()).toEqual(['verify', 'doctor']);
    endA();
    expect(store.busy()).toBe(true);
    endB();
    expect(store.busy()).toBe(false);
  });

  it('is idempotent on double-end', () => {
    const store = createActivityStore();
    const end = store.begin('x');
    end();
    end();
    expect(store.busy()).toBe(false);
  });

  it('distinguishes two begin calls with the same label', () => {
    const store = createActivityStore();
    const endA = store.begin('verify');
    const endB = store.begin('verify');
    expect(store.labels()).toEqual(['verify', 'verify']);
    endA();
    expect(store.busy()).toBe(true);
    expect(store.labels()).toEqual(['verify']);
    endB();
    expect(store.busy()).toBe(false);
  });
});
