import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * WHY: ownership is resolved on EVERY `/v1/runs*` request — every create, every list, and the
 * preamble of every SSE tail — and the read behind it is synchronous. A synchronous file read on the
 * daemon's event loop blocks every other request in the process, and it was re-deriving a value that
 * changes at most once per studio launch.
 *
 * The guard is the file's identity rather than a clock, because `writeHandle` is temp-file + rename:
 * a republished handle is always a new inode, so there is no window in which a stale answer can be
 * served. These rows pin both directions — the cache must save the read, and it must not survive the
 * handle it was read from.
 */
const counters = vi.hoisted(() => ({ reads: 0 }));

vi.mock('../../../src/studio/handle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/handle.js')>();
  return {
    ...actual,
    readHandle: (dataDir?: string) => {
      counters.reads++;
      return actual.readHandle(dataDir);
    },
  };
});

const { writeHandle, removeHandle } = await import('../../../src/studio/handle.js');
const { resolveRunsOwner, _resetRunsOwnerHandleCache } = await import('../../../src/daemon/rest/runs-owner.js');

describe('the studio handle is re-read only when it changes', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-runs-owner-cache-'));
    _resetRunsOwnerHandleCache();
    counters.reads = 0;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads the handle once across two consecutive requests', () => {
    writeHandle({ id: 's1', endpoint: 'http://127.0.0.1:9310', token: 'host-token', pid: process.pid, instanceId: 'host-a' }, dataDir);

    const first = resolveRunsOwner(dataDir);
    const second = resolveRunsOwner(dataDir);

    expect(first).toEqual({ kind: 'proxy', endpoint: 'http://127.0.0.1:9310', token: 'host-token' });
    expect(second).toEqual(first);
    expect(counters.reads).toBe(1);
  });

  it('re-reads when the handle is republished — a cached endpoint must never outlive its file', () => {
    writeHandle({ id: 's1', endpoint: 'http://127.0.0.1:9310', token: 'host-token', pid: process.pid, instanceId: 'host-a' }, dataDir);
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'proxy', endpoint: 'http://127.0.0.1:9310', token: 'host-token' });

    // A relaunched host: same path, new file. Serving the old endpoint here would send every run
    // request — and the bearer token with it — at a port nobody is listening on.
    writeHandle({ id: 's2', endpoint: 'http://127.0.0.1:9411', token: 'new-token', pid: process.pid, instanceId: 'host-b' }, dataDir);

    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'proxy', endpoint: 'http://127.0.0.1:9411', token: 'new-token' });
    expect(counters.reads).toBe(2);
  });

  it('answers local without reading anything when no handle is published', () => {
    removeHandle(dataDir);

    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
    expect(counters.reads).toBe(0);
  });

  it('forgets a cached handle the moment the file is removed', () => {
    writeHandle({ id: 's1', endpoint: 'http://127.0.0.1:9310', token: 'host-token', pid: process.pid, instanceId: 'host-a' }, dataDir);
    expect(resolveRunsOwner(dataDir).kind).toBe('proxy');

    // The host shut down cleanly and took its handle with it. A cache that kept answering `proxy`
    // would 502 every run request the daemon could perfectly well serve itself.
    removeHandle(dataDir);

    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
  });

  it('keys the cache on the directory, so two data dirs cannot answer for each other', () => {
    const other = mkdtempSync(join(tmpdir(), 'wigolo-runs-owner-cache-other-'));
    try {
      writeHandle({ id: 's1', endpoint: 'http://127.0.0.1:9310', token: 'host-token', pid: process.pid, instanceId: 'host-a' }, dataDir);
      expect(resolveRunsOwner(dataDir).kind).toBe('proxy');
      expect(resolveRunsOwner(other)).toEqual({ kind: 'local' });
      expect(resolveRunsOwner(dataDir).kind).toBe('proxy');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  /**
   * The must-not-cache half. A host can die without touching its handle, so liveness has to be
   * re-derived every time — a cached `proxy` answer would keep routing to a dead socket for as long
   * as the file sat there.
   */
  it('re-checks liveness on every request, not only when the file changes', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid as number;

    writeHandle({ id: 's1', endpoint: 'http://127.0.0.1:9310', token: 'host-token', pid, instanceId: 'host-a' }, dataDir);
    expect(resolveRunsOwner(dataDir).kind).toBe('proxy');

    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    // Same file, same inode, same mtime — and a different answer, because the process behind it is
    // gone. Caching the RESOLVED owner rather than the handle would get this wrong.
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
  });
});
