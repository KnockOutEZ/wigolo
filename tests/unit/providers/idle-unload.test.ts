import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIdleUnload } from '../../../src/providers/idle-unload.js';

describe('createIdleUnload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs onIdle once the timeout elapses after the last call', async () => {
    const onIdle = vi.fn();
    const clock = createIdleUnload({ timeoutMs: 1000, onIdle, label: 'test' });

    clock.begin();
    clock.end();
    expect(clock.isArmed()).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(onIdle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(clock.isArmed()).toBe(false);
  });

  it('restarts the countdown on every call', async () => {
    const onIdle = vi.fn();
    const clock = createIdleUnload({ timeoutMs: 1000, onIdle });

    clock.begin();
    clock.end();
    await vi.advanceTimersByTimeAsync(900);

    clock.begin();
    clock.end();
    await vi.advanceTimersByTimeAsync(900);
    expect(onIdle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('never unloads while a call is in flight, and re-arms when it settles', async () => {
    const onIdle = vi.fn();
    const clock = createIdleUnload({ timeoutMs: 100, onIdle });

    clock.begin();
    await vi.advanceTimersByTimeAsync(500);
    expect(onIdle).not.toHaveBeenCalled();
    expect(clock.isArmed()).toBe(false);

    clock.end();
    expect(clock.isArmed()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('counts concurrent calls and unloads only after the last one ends', async () => {
    const onIdle = vi.fn();
    const clock = createIdleUnload({ timeoutMs: 50, onIdle });

    clock.begin();
    clock.begin();
    clock.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(onIdle).not.toHaveBeenCalled();

    clock.end();
    await vi.advanceTimersByTimeAsync(50);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('stays disabled when the timeout is not positive', async () => {
    for (const timeoutMs of [0, -1, Number.NaN]) {
      const onIdle = vi.fn();
      const clock = createIdleUnload({ timeoutMs, onIdle });

      clock.begin();
      clock.end();
      expect(clock.isArmed()).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(onIdle).not.toHaveBeenCalled();
    }
  });

  it('cancel stops an armed countdown', async () => {
    const onIdle = vi.fn();
    const clock = createIdleUnload({ timeoutMs: 100, onIdle });

    clock.begin();
    clock.end();
    clock.cancel();
    expect(clock.isArmed()).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('swallows a rejecting onIdle instead of raising an unhandled rejection', async () => {
    const onIdle = vi.fn(async () => {
      throw new Error('dispose blew up');
    });
    const clock = createIdleUnload({ timeoutMs: 10, onIdle });

    clock.begin();
    clock.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(onIdle).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});