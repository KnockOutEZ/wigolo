import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../../../src/searxng/process.js';

describe('searxng acquireLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-lock-'));
  });

  afterEach(() => {
    try { chmodSync(dir, 0o700); } catch { /* */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('acquires when no lock present', () => {
    const r = acquireLock(dir);
    expect(r.acquired).toBe(true);
    expect(existsSync(join(dir, 'searxng.lock'))).toBe(true);
  });

  it('reports existing pid when lock points at a live process', () => {
    writeFileSync(
      join(dir, 'searxng.lock'),
      JSON.stringify({ pid: process.pid, port: 4242 }),
    );
    const r = acquireLock(dir);
    expect(r.acquired).toBe(false);
    expect(r.existingPid).toBe(process.pid);
    expect(r.existingPort).toBe(4242);
  });

  it('cleans a stale lock (dead pid) and acquires', () => {
    // pid 1 is reserved (init); we are not root so process.kill(1, 0) throws → treated as dead.
    // Use a clearly-unused-large pid to be safe.
    writeFileSync(
      join(dir, 'searxng.lock'),
      JSON.stringify({ pid: 999999999, port: 7777 }),
    );
    const r = acquireLock(dir);
    expect(r.acquired).toBe(true);
  });

  it('does not throw if unlink permission denied (best-effort cleanup)', () => {
    writeFileSync(join(dir, 'searxng.lock'), '{ malformed json');
    // Remove write perm on the directory so unlink will EPERM.
    chmodSync(dir, 0o555);
    try {
      // Should not throw even when the unlink fails.
      expect(() => acquireLock(dir)).not.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('releaseLock removes lock + port files without throwing', () => {
    writeFileSync(join(dir, 'searxng.lock'), '{}');
    writeFileSync(join(dir, 'searxng.port'), '4000');
    releaseLock(dir);
    expect(existsSync(join(dir, 'searxng.lock'))).toBe(false);
    expect(existsSync(join(dir, 'searxng.port'))).toBe(false);
  });
});
