import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { studioStateDir } from './paths.js';

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
  /**
   * Collision-resistant host-instance id (random per launch). The self-reference
   * guard matches on THIS, not `pid`: a bare-pid check false-positives across PID
   * reuse (a dead host leaves a stale handle, the OS hands its pid to a new stdio
   * server, which would wrongly refuse-self instead of proxying / reporting
   * no-reachable-host). A non-host process holds no instance id, so it cannot match.
   */
  instanceId: string;
}

/**
 * The current process's host-instance id, set ONLY in the live host process at
 * launch (in memory). The self-reference check is `handle.instanceId === getMyInstanceId()`
 * — null in any non-host process, so it can never false-match.
 */
let myInstanceId: string | null = null;
export function setMyInstanceId(id: string | null): void {
  myInstanceId = id;
}
export function getMyInstanceId(): string | null {
  return myInstanceId;
}

function studioDir(dataDir?: string): string {
  return studioStateDir(dataDir);
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
