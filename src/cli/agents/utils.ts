import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, lstatSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

export function getPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli/agents/utils.js → ../../.. = package root
  return join(here, '..', '..', '..');
}

export function getVersion(): string {
  try {
    const raw = readFileSync(join(getPackageRoot(), 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function readAsset(relPath: string): string {
  const full = join(getPackageRoot(), 'assets', relPath);
  return readFileSync(full, 'utf-8').replace(/\{version\}/g, getVersion());
}

/**
 * If a backup file already exists at `bakPath`, rename it to a timestamped
 * sibling so a subsequent backup write does not destroy the prior copy.
 * Silent no-op when no backup exists or the rename fails — best-effort safety
 * net for repeated interrupted installs.
 */
function rotateBackup(bakPath: string): void {
  if (!existsSync(bakPath)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${bakPath}.${ts}`;
  let suffix = 0;
  while (existsSync(target)) {
    suffix += 1;
    target = `${bakPath}.${ts}-${suffix}`;
  }
  try {
    renameSync(bakPath, target);
  } catch {
    // best-effort — leave the existing bak in place rather than crash
  }
}

/**
 * Merge a block (delimited by wigolo:start/wigolo:end markers) into a file.
 * Creates the file if it doesn't exist.
 * Replaces an existing block, or appends if no block present.
 *
 * Mismatched markers (one present, not both) are treated as corruption from a
 * previously interrupted write — the file is backed up to <path>.wigolo-bak
 * and the mismatched marker is stripped before the new block is appended.
 * Without this guard the next merge would eat user content between the
 * orphan marker and the freshly-written end marker.
 */
export function mergeBlock(filePath: string, block: string): void {
  mkdirSync(dirname(filePath), { recursive: true });

  const START = '<!-- wigolo:start';
  const END = '<!-- wigolo:end -->';

  if (!existsSync(filePath)) {
    writeFileSync(filePath, block.trimEnd() + '\n', 'utf-8');
    return;
  }

  const content = readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(START);
  const endIdx = content.indexOf(END);
  const hasStart = startIdx !== -1;
  const hasEnd = endIdx !== -1;

  if (hasStart && hasEnd) {
    const before = content.slice(0, startIdx).trimEnd();
    const after = content.slice(endIdx + END.length).trimStart();
    const parts = [before, block.trimEnd(), after].filter(Boolean);
    writeFileSync(filePath, parts.join('\n\n') + '\n', 'utf-8');
    return;
  }

  if (hasStart !== hasEnd) {
    rotateBackup(filePath + '.wigolo-bak');
    writeFileSync(filePath + '.wigolo-bak', content, 'utf-8');

    let salvaged = content;
    if (hasStart) {
      // Drop everything from the orphan start marker to end-of-line.
      const lineEnd = content.indexOf('\n', startIdx);
      salvaged = (content.slice(0, startIdx).trimEnd()
        + (lineEnd === -1 ? '' : '\n' + content.slice(lineEnd + 1))).trimEnd();
    } else {
      // Drop the orphan end marker line.
      const lineStart = content.lastIndexOf('\n', endIdx);
      const lineEnd = content.indexOf('\n', endIdx);
      const head = lineStart === -1 ? '' : content.slice(0, lineStart);
      const tail = lineEnd === -1 ? '' : content.slice(lineEnd + 1);
      salvaged = (head + (head && tail ? '\n' : '') + tail).trimEnd();
    }

    const out = salvaged
      ? salvaged + '\n\n' + block.trimEnd() + '\n'
      : block.trimEnd() + '\n';
    writeFileSync(filePath, out, 'utf-8');
    return;
  }

  const trimmed = content.trimEnd();
  writeFileSync(filePath, trimmed + '\n\n' + block.trimEnd() + '\n', 'utf-8');
}

/**
 * Remove the wigolo block from a file. Returns true if a block was removed.
 *
 * If the block was the file's only content, the file is unlinked rather than
 * left as a 0-byte stub. Symlinks are never unlinked — they may resolve to
 * user content outside the file we own.
 */
export function removeBlock(filePath: string): boolean {
  if (!existsSync(filePath)) return false;

  const START = '<!-- wigolo:start';
  const END = '<!-- wigolo:end -->';
  const content = readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(START);
  const endIdx = content.indexOf(END);

  if (startIdx === -1 || endIdx === -1) return false;

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + END.length).trimStart();
  const parts = [before, after].filter(Boolean);
  const newContent = parts.join('\n\n');

  if (!newContent) {
    let isSymlink = false;
    try {
      isSymlink = lstatSync(filePath).isSymbolicLink();
    } catch {
      isSymlink = false;
    }
    if (!isSymlink) {
      try {
        unlinkSync(filePath);
        return true;
      } catch {
        // fall through to truncate
      }
    }
    writeFileSync(filePath, '', 'utf-8');
    return true;
  }

  writeFileSync(filePath, newContent + '\n', 'utf-8');
  return true;
}

/**
 * Create or merge an MCP server entry into a JSON config file.
 * keyPath like ['mcpServers', 'wigolo'] navigates/creates nested keys.
 * Other servers in the file are preserved.
 */
export function mergeMcpJson(
  configPath: string,
  entry: Record<string, unknown>,
  keyPath: string[],
): void {
  mkdirSync(dirname(configPath), { recursive: true });

  let root: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      root = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      root = {};
    }
  }

  let obj = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (typeof obj[key] !== 'object' || obj[key] === null) {
      obj[key] = {};
    }
    obj = obj[key] as Record<string, unknown>;
  }
  obj[keyPath[keyPath.length - 1]] = entry;

  writeFileSync(configPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
}

/** Remove the wigolo entry from a JSON MCP config, preserving other servers. */
export function removeMcpJson(configPath: string, keyPath: string[]): void {
  if (!existsSync(configPath)) return;

  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }

  let obj = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (typeof obj[key] !== 'object' || obj[key] === null) return;
    obj = obj[key] as Record<string, unknown>;
  }
  delete obj[keyPath[keyPath.length - 1]];

  writeFileSync(configPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
}

/** Detect whether wigolo is installed globally and return the appropriate command. */
export function getMcpCommand(): { command: string; args: string[] } {
  try {
    const path = execSync('which wigolo', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (path) {
      return { command: 'wigolo', args: [] };
    }
  } catch {
    // not found globally
  }
  return { command: 'npx', args: ['-y', 'wigolo'] };
}
