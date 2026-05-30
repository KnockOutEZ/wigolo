import { describe, it, expect, vi } from 'vitest';
import { createToastStore } from '../../../../../src/cli/tui/state/toast-store.js';

describe('toast-store', () => {
  it('emits a toast that auto-expires after ttl', async () => {
    vi.useFakeTimers();
    const store = createToastStore();
    store.push({ message: 'Saved · LLM provider', severity: 'ok', ttl: 3000 });
    expect(store.current()).toMatchObject({ message: 'Saved · LLM provider' });
    vi.advanceTimersByTime(3001);
    expect(store.current()).toBeNull();
    vi.useRealTimers();
  });

  it('coalesces save toasts within 800ms into a single counted toast', () => {
    vi.useFakeTimers();
    const store = createToastStore();
    store.push({ message: 'Saved · A', severity: 'ok', ttl: 3000, group: 'save' });
    vi.advanceTimersByTime(200);
    store.push({ message: 'Saved · B', severity: 'ok', ttl: 3000, group: 'save' });
    vi.advanceTimersByTime(200);
    store.push({ message: 'Saved · C', severity: 'ok', ttl: 3000, group: 'save' });
    expect(store.current()?.message).toBe('Saved · 3 fields');
    vi.useRealTimers();
  });

  it('does not coalesce non-save toasts', () => {
    const store = createToastStore();
    store.push({ message: 'Failed: x', severity: 'err', ttl: 5000 });
    store.push({ message: 'Failed: y', severity: 'err', ttl: 5000 });
    expect(store.queue().length).toBe(2);
  });

  it('does not coalesce save toasts after prior save has expired', () => {
    vi.useFakeTimers();
    const store = createToastStore();
    store.push({ message: 'Saved · A', severity: 'ok', ttl: 500, group: 'save' });
    vi.advanceTimersByTime(600);
    expect(store.current()).toBeNull();
    store.push({ message: 'Saved · B', severity: 'ok', ttl: 3000, group: 'save' });
    expect(store.current()?.message).toBe('Saved · B');
    vi.useRealTimers();
  });

  it('coalesced save toast still auto-expires after the most recent push + ttl', () => {
    vi.useFakeTimers();
    const store = createToastStore();
    store.push({ message: 'Saved · A', severity: 'ok', ttl: 3000, group: 'save' });
    vi.advanceTimersByTime(200);
    store.push({ message: 'Saved · B', severity: 'ok', ttl: 3000, group: 'save' });
    vi.advanceTimersByTime(200);
    store.push({ message: 'Saved · C', severity: 'ok', ttl: 3000, group: 'save' });
    expect(store.current()?.message).toBe('Saved · 3 fields');
    vi.advanceTimersByTime(3001);
    expect(store.current()).toBeNull();
    vi.useRealTimers();
  });
});
