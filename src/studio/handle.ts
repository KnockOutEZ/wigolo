import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';

/**
 * The active-session handle the Studio host writes on launch so the user's
 * stdio MCP server can discover, target, and authenticate against the live
 * session. It carries a bearer token, so it is written 0600. Default location:
 * `~/.wigolo/studio/current.json`.
 */
export interface SessionHandle {
  id: string;
  endpoint: string;
  token: string;
  pid: number;
}

function studioDir(dataDir?: string): string {
  return join(dataDir ?? getConfig().dataDir, 'studio');
}

export function studioHandlePath(dataDir?: string): string {
  return join(studioDir(dataDir), 'current.json');
}

/** Atomically write the handle (temp + rename) with 0600 perms. */
export function writeHandle(handle: SessionHandle, dataDir?: string): void {
  const dir = studioDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const finalPath = join(dir, 'current.json');
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(handle), { mode: 0o600 });
  chmodSync(tmpPath, 0o600); // deterministic regardless of umask
  renameSync(tmpPath, finalPath);
}

/** Read the handle; returns null if absent, unreadable, or malformed (never throws). */
export function readHandle(dataDir?: string): SessionHandle | null {
  try {
    const parsed = JSON.parse(readFileSync(studioHandlePath(dataDir), 'utf-8')) as SessionHandle;
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.endpoint !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Remove the handle file; idempotent (no throw if already gone). */
export function removeHandle(dataDir?: string): void {
  rmSync(studioHandlePath(dataDir), { force: true });
}
