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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reject the keys that would walk into `Object.prototype`. `keyPath` is a
 * module constant at every call site today, but this is an exported generic
 * helper and the signature invites a dynamic caller.
 */
function assertSafeKey(key: string): string {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error(`refusing to write reserved key "${key}"`);
  }
  return key;
}

/**
 * Parse a JSON config that must be an object. Anything else — invalid JSON, an
 * array, a bare primitive — throws rather than being silently replaced: the
 * target here is the user's own config, and a wrong guess costs them the file.
 */
function readJsonObject(configPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `${configPath} is not valid JSON, refusing to overwrite it: ${String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `${configPath} is not a JSON object, refusing to overwrite it`,
    );
  }
  return parsed;
}

/**
 * Write via a sibling temp file + rename. A plain `writeFileSync` truncates
 * first, so an interrupted write would leave the user with a truncated or empty
 * config — the whole file, not just our one entry.
 */
function writeJsonAtomic(configPath: string, root: unknown): void {
  const tmp = `${configPath}.wigolo-tmp`;
  writeFileSync(tmp, JSON.stringify(root, null, 2) + '\n', 'utf-8');
  try {
    renameSync(tmp, configPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* leave it rather than mask the real error */ }
    throw err;
  }
}

/**
 * Append values to a string array nested at `keyPath`, creating the path when
 * absent. Idempotent — values already present are skipped, so re-running an
 * install never duplicates a rule.
 *
 * Unlike `mergeMcpJson` this must not clobber the target: the file it is aimed
 * at (`~/.claude/settings.json`) is the user's own, and the array it edits sits
 * beside settings wigolo has no business rewriting. Returns the values it
 * actually added.
 */
export function mergeJsonArray(
  configPath: string,
  keyPath: string[],
  values: string[],
): string[] {
  mkdirSync(dirname(configPath), { recursive: true });

  const root = existsSync(configPath) ? readJsonObject(configPath) : {};

  let obj = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = assertSafeKey(keyPath[i]);
    if (!isPlainObject(obj[key])) {
      obj[key] = {};
    }
    obj = obj[key] as Record<string, unknown>;
  }

  const leaf = assertSafeKey(keyPath[keyPath.length - 1]);
  const existing = Array.isArray(obj[leaf]) ? (obj[leaf] as unknown[]) : [];
  const added = values.filter((v) => !existing.includes(v));
  if (added.length === 0) return [];

  obj[leaf] = [...existing, ...added];
  writeJsonAtomic(configPath, root);
  return added;
}

/**
 * Remove exactly the given values from a string array nested at `keyPath`.
 * Everything else in the array — and in the file — is left alone. Returns the
 * values actually removed.
 */
export function removeJsonArrayValues(
  configPath: string,
  keyPath: string[],
  values: string[],
): string[] {
  if (!existsSync(configPath)) return [];

  // Unlike the install path this throws rather than returning silently, so an
  // uninstall that leaves the rule behind says so instead of claiming success.
  const root = readJsonObject(configPath);

  let obj = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = assertSafeKey(keyPath[i]);
    if (!isPlainObject(obj[key])) return [];
    obj = obj[key] as Record<string, unknown>;
  }

  const leaf = assertSafeKey(keyPath[keyPath.length - 1]);
  if (!Array.isArray(obj[leaf])) return [];

  const existing = obj[leaf] as unknown[];
  const removed = values.filter((v) => existing.includes(v));
  if (removed.length === 0) return [];

  obj[leaf] = existing.filter((v) => !values.includes(v as string));
  writeJsonAtomic(configPath, root);
  return removed;
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
