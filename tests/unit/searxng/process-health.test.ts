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
