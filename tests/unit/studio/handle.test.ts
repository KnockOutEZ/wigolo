import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHandle, readHandle, removeHandle, studioHandlePath } from '../../../src/studio/handle.js';

describe('studio/handle', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-studio-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const handle = { id: 'sid', endpoint: 'http://127.0.0.1:7777', token: 'tok-abc', pid: 12345 };

  it('writes the handle and reads it back', () => {
    writeHandle(handle, dataDir);
    expect(existsSync(studioHandlePath(dataDir))).toBe(true);
    expect(readHandle(dataDir)).toEqual(handle);
  });

  it('writes the handle file with 0600 permissions (it carries a bearer token)', () => {
    writeHandle(handle, dataDir);
    const mode = statSync(studioHandlePath(dataDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readHandle returns null when no handle exists (not throw)', () => {
    expect(readHandle(dataDir)).toBeNull();
  });

  it('readHandle returns null on a corrupt handle (not throw)', () => {
    writeHandle(handle, dataDir);
    writeFileSync(studioHandlePath(dataDir), 'not json{', { mode: 0o600 });
    expect(readHandle(dataDir)).toBeNull();
  });

  it('removeHandle deletes the file and is idempotent on a missing file', () => {
    writeHandle(handle, dataDir);
    removeHandle(dataDir);
    expect(existsSync(studioHandlePath(dataDir))).toBe(false);
    expect(() => removeHandle(dataDir)).not.toThrow();
  });
});
