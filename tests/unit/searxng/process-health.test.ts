import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { SearxngProcess } from '../../../src/searxng/process.js';

describe('SearxngProcess — callbacks', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('fires onUnhealthy once when crash limit is reached', () => {
    const onUnhealthy = vi.fn();
    const onHealthy = vi.fn();
    const p = new SearxngProcess('/tmp/searxng', '/tmp/.wigolo', { onUnhealthy, onHealthy });

    const fakeChild = new EventEmitter() as unknown as import('node:child_process').ChildProcess;
    (p as unknown as { child: typeof fakeChild }).child = fakeChild;
    (p as unknown as { monitorCrashes: () => void }).monitorCrashes();

    fakeChild.emit('exit', 1);
    fakeChild.emit('exit', 1);
    fakeChild.emit('exit', 1);

    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(onUnhealthy.mock.calls[0][0]).toMatch(/crashed 3 times/);
    expect(onHealthy).not.toHaveBeenCalled();

    fakeChild.emit('exit', 1);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
  });
});

describe('SearxngProcess — /healthz probe', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function setupRunning(p: SearxngProcess, port = 8888): void {
    (p as unknown as { port: number | null }).port = port;
    (p as unknown as { stopped: boolean }).stopped = false;
  }

  it('fires onUnhealthy after 3 consecutive probe failures', async () => {
    const onUnhealthy = vi.fn();
    const p = new SearxngProcess('/tmp/searxng', '/tmp/.wigolo', { onUnhealthy });
    setupRunning(p);

    vi.mocked(global.fetch).mockRejectedValue(new Error('network down'));
    (p as unknown as { startHealthProbe: () => void }).startHealthProbe();

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(onUnhealthy.mock.calls[0][0]).toMatch(/healthz/i);
  });

  it('fires onHealthy once when probe succeeds after being unhealthy', async () => {
    const onUnhealthy = vi.fn();
    const onHealthy = vi.fn();
    const p = new SearxngProcess('/tmp/searxng', '/tmp/.wigolo', { onUnhealthy, onHealthy });
    setupRunning(p);
    (p as unknown as { isCurrentlyUnhealthy: boolean }).isCurrentlyUnhealthy = true;

    vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);
    (p as unknown as { startHealthProbe: () => void }).startHealthProbe();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(onHealthy).toHaveBeenCalledTimes(1);
    expect(onUnhealthy).not.toHaveBeenCalled();
  });

  it('does not double-fire onUnhealthy on a 4th failure', async () => {
    const onUnhealthy = vi.fn();
    const p = new SearxngProcess('/tmp/searxng', '/tmp/.wigolo', { onUnhealthy });
    setupRunning(p);
    vi.mocked(global.fetch).mockRejectedValue(new Error('down'));
    (p as unknown as { startHealthProbe: () => void }).startHealthProbe();

    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(30_000);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
  });
});
