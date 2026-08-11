import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/*
 * The forced condition for the Windows lock crash.
 *
 * Observed on windows-latest CI, from the F17 cross-process race:
 *
 *   Error: EPERM: operation not permitted, mkdir '...\skills\receipts.lock'
 *       at acquireLock (src/cli/agents/skills/receipts.ts:230)
 *
 * `acquireLock` treated every non-EEXIST mkdir error as fatal, but EPERM is how Windows
 * reports a lock dir that EXISTS and is delete-pending — the window a releasing writer opens
 * between its rmdir and the last handle closing. So the losing writer of a normal race died on
 * a condition whose whole meaning is "wait 10ms and try again".
 *
 * That condition is Windows-only in the wild and cannot be produced on POSIX, so it is INJECTED
 * here at the mkdir seam. Injection is what makes the fix falsifiable on any platform: these
 * tests fail on the pre-fix module for the exact reason CI did, and the counters assert the
 * injection actually fired rather than being silently bypassed.
 */

const inject = vi.hoisted(() => ({ remaining: 0, code: 'EPERM' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realMkdir = actual.mkdirSync as (p: unknown, o?: unknown) => string | undefined;
  return {
    ...actual,
    // Only the LOCK dir is intercepted. The data dir mkdir, and every other fs call this suite
    // and the module under test make, run for real — an fs mock that faked more than the one
    // syscall under study would stop proving anything about the real lock.
    mkdirSync: (p: unknown, o?: unknown) => {
      if (inject.remaining > 0 && String(p).endsWith('receipts.lock')) {
        inject.remaining--;
        const err: NodeJS.ErrnoException = new Error(
          `${inject.code}: operation not permitted, mkdir '${String(p)}'`,
        );
        err.code = inject.code;
        err.syscall = 'mkdir';
        throw err;
      }
      return realMkdir(p, o);
    },
  };
});

let tmpHome: string;
let tmpData: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

vi.mock('../../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: tmpData })),
}));

async function load() {
  return import('../../../../../src/cli/agents/skills/receipts.js');
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `wigolo-rcpt-eperm-home-${stamp}`);
  tmpData = join(tmpdir(), `wigolo-rcpt-eperm-data-${stamp}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(tmpData, { recursive: true });
  inject.remaining = 0;
  inject.code = 'EPERM';
  vi.resetModules();
});

afterEach(() => {
  inject.remaining = 0;
  for (const d of [tmpHome, tmpData]) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

const entry = {
  scope: 'global' as const,
  agents: ['claude-code'],
  packs: {},
  installedAt: 'now',
};

describe('acquireLock — Windows delete-pending mkdir (EPERM)', () => {
  it('a transient EPERM burst is waited out, not fatal — the write still lands', async () => {
    inject.remaining = 3;

    const { withReceiptsLock, readReceipts } = await load();
    const key = join(tmpHome, 'w');

    withReceiptsLock((store) => {
      store[key] = entry;
      return { store, result: undefined };
    });

    // The outside signal: the injection is only meaningful if it actually fired. A fix that
    // accidentally stopped calling mkdirSync on the lock would leave this at 3 and pass the
    // assertion below on a store that was never contended.
    expect(inject.remaining, 'the injected EPERM burst never reached acquireLock').toBe(0);
    expect(readReceipts()[key], 'a transient EPERM killed the writer instead of retrying').toBeDefined();
  });

  it('a permanent EPERM gives up on its own budget and throws ITSELF, not a lock timeout', async () => {
    // The retry must not become the third unbounded synchronous loop in this file's history.
    // A permanent EPERM is the shape that would spin forever, and the wrong bound is nearly as
    // bad as none: laundering a real permission fault into "lock acquisition timed out" ten
    // seconds later hides the cause. So this pins BOTH the bound and the error identity.
    inject.remaining = Number.MAX_SAFE_INTEGER;

    const { withReceiptsLock } = await load();
    const started = Date.now();

    let thrown: NodeJS.ErrnoException | undefined;
    try {
      withReceiptsLock((store) => ({ store, result: undefined }));
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }

    const elapsed = Date.now() - started;
    expect(thrown, 'a permanent EPERM was swallowed — acquire returned as if it held the lock').toBeDefined();
    expect(thrown?.code, 'the original EPERM was laundered into another error').toBe('EPERM');
    expect(thrown?.message ?? '').not.toContain('timed out');
    expect(elapsed, 'the EPERM retry outlived its budget').toBeLessThan(4_000);
  });

  it('a non-EPERM mkdir failure is still fatal on the first try — no retry, no budget', async () => {
    // Must-not-fire probe. The retry is scoped to the one code that means "delete-pending".
    // If it widened to "any mkdir error", a genuinely unwritable data dir would busy-wait for
    // half a second and then report the same thing it could have reported immediately.
    inject.remaining = 2;
    inject.code = 'EACCES';

    const { withReceiptsLock } = await load();

    let thrown: NodeJS.ErrnoException | undefined;
    try {
      withReceiptsLock((store) => ({ store, result: undefined }));
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }

    expect(thrown?.code).toBe('EACCES');
    // One consumed, one left: proof it threw on the first answer rather than retrying into
    // the second. A retry-everything acquire would drain this to 0.
    expect(inject.remaining, 'a non-EPERM mkdir error was retried').toBe(1);
  });
});
