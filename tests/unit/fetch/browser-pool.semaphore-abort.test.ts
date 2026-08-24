import { describe, expect, it } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

describe('dedicated browser semaphore abort handling', () => {
  it('removes an aborted waiter without consuming the next released slot', async () => {
    process.env.MAX_BROWSERS = '1';
    resetConfig();

    const pool = new MultiBrowserPool();
    const internals = pool as unknown as {
      acquireStealthSlot: (signal?: AbortSignal) => Promise<void>;
      releaseStealthSlot: () => void;
      stealthWaitQueue: unknown[];
    };

    await internals.acquireStealthSlot();
    const controller = new AbortController();
    const queued = internals.acquireStealthSlot(controller.signal);
    controller.abort(new DOMException('stage_timeout', 'AbortError'));
    await Promise.resolve();

    expect(internals.stealthWaitQueue).toHaveLength(0);
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });

    internals.releaseStealthSlot();
    await expect(internals.acquireStealthSlot()).resolves.toBeUndefined();
    internals.releaseStealthSlot();

    delete process.env.MAX_BROWSERS;
    resetConfig();
    await pool.shutdown();
  });
});
