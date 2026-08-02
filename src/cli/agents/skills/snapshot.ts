import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeEol } from './catalog.js';
import type { Snapshot, SnapshotEntry } from './types.js';

/** sha256 over EOL-normalized bytes. */
export function sha256(content: string): string {
  return createHash('sha256').update(normalizeEol(content), 'utf-8').digest('hex');
}

/**
 * lstat a single path WITHOUT following symlinks. Content + hash are captured
 * for files; symlink targets are read (may dangle) for diagnostics.
 */
export function snapshotPath(path: string, captureContent = false): SnapshotEntry {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { kind: 'absent' };
  }

  if (st.isSymbolicLink()) {
    let linkTarget: string | undefined;
    try {
      linkTarget = readlinkSync(path);
    } catch {
      linkTarget = undefined;
    }
    return { kind: 'symlink', linkTarget };
  }

  if (st.isDirectory()) {
    return { kind: 'dir' };
  }

  if (st.isFile()) {
    let content: string | undefined;
    let hash: string | undefined;
    try {
      const raw = readFileSync(path, 'utf-8');
      hash = sha256(raw);
      if (captureContent) content = normalizeEol(raw);
    } catch {
      // unreadable file — treat as present-but-opaque
    }
    return { kind: 'file', sha256: hash, content };
  }

  // Sockets/FIFOs/devices — reported as 'file' (with no hash) so that a socket
  // sitting where a pack DIR must go trips the "regular file where a dir must
  // go" refuse rather than being silently written through.
  return { kind: 'file' };
}

/**
 * Gather a snapshot of many paths in ONE pass. `captureContentFor` names the
 * paths (fenced/owned-file targets) whose content we keep for block merging.
 */
export function gatherSnapshot(
  paths: string[],
  captureContentFor: Set<string> = new Set(),
): Snapshot {
  const snap: Snapshot = {};
  for (const p of paths) {
    snap[p] = snapshotPath(p, captureContentFor.has(p));
  }
  return snap;
}
