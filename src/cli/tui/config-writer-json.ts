import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export type WriteCode =
  | 'OK'
  | 'PERMISSION_DENIED'
  | 'PARSE_ERROR'
  | 'MKDIR_FAILED'
  | 'WRITE_FAILED';

export interface WriteJsonConfigArgs {
  path: string;
  keyPath: string[];
  entry: Record<string, unknown>;
  dryRun?: boolean;
  allowJsonc?: boolean;
  requireBackup?: boolean;
}

export interface WriteJsonConfigResult {
  ok: boolean;
  code: WriteCode;
  message?: string;
  dryRun?: boolean;
  backupPath?: string;
}

export interface RemoveJsonConfigEntryArgs {
  path: string;
  keyPath: string[];
  dryRun?: boolean;
  allowJsonc?: boolean;
  requireBackup?: boolean;
}

export interface RemoveJsonConfigEntryResult extends WriteJsonConfigResult {
  removed: boolean;
}

function setAtPath(obj: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let cursor = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const k = keyPath[i];
    if (typeof cursor[k] !== 'object' || cursor[k] === null || Array.isArray(cursor[k])) {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[keyPath[keyPath.length - 1]] = value;
}

function removeAtPath(obj: Record<string, unknown>, keyPath: string[]): boolean {
  if (keyPath.length === 0) return false;
  let cursor = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const k = keyPath[i];
    if (typeof cursor[k] !== 'object' || cursor[k] === null || Array.isArray(cursor[k])) {
      return false;
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  const leaf = keyPath[keyPath.length - 1];
  if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) return false;
  delete cursor[leaf];
  return true;
}

/** Normalize OpenCode-style JSONC without evaluating arbitrary code. */
function normalizeJsonc(text: string): string {
  const withoutComments: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      withoutComments.push(ch);
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      withoutComments.push(ch);
      continue;
    }

    if (ch === '/' && next === '/') {
      withoutComments.push(' ', ' ');
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
        withoutComments.push(' ');
        i++;
      }
      if (i < text.length) withoutComments.push(text[i]);
      continue;
    }

    if (ch === '/' && next === '*') {
      withoutComments.push(' ', ' ');
      i += 2;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          withoutComments.push(' ', ' ');
          i++;
          closed = true;
          break;
        }
        withoutComments.push(text[i] === '\n' || text[i] === '\r' ? text[i] : ' ');
        i++;
      }
      if (!closed) throw new SyntaxError('unterminated block comment');
      continue;
    }

    withoutComments.push(ch);
  }

  const chars = withoutComments;
  inString = false;
  escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== ',') continue;
    let j = i + 1;
    while (j < chars.length && /\s/.test(chars[j])) j++;
    if (chars[j] === '}' || chars[j] === ']') chars[i] = ' ';
  }
  return chars.join('');
}

export function parseJsonObject(raw: string, allowJsonc: boolean): Record<string, unknown> {
  const parsed = JSON.parse(allowJsonc ? normalizeJsonc(raw) : raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('existing config is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function isPermissionError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : '';
  const message = err instanceof Error ? err.message : String(err);
  return code === 'EACCES' || code === 'EPERM' || /EACCES|EPERM/.test(message);
}

async function fileReadable(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonFile(
  path: string,
  json: string,
  exists: boolean,
  requireBackup: boolean,
): Promise<WriteJsonConfigResult> {
  try {
    await fs.mkdir(dirname(path), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isPermissionError(err)) {
      return { ok: false, code: 'PERMISSION_DENIED', message };
    }
    return { ok: false, code: 'MKDIR_FAILED', message };
  }

  let existingMode: number | undefined;
  if (exists) {
    try {
      existingMode = (await fs.stat(path)).mode & 0o777;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'WRITE_FAILED', message: `unable to inspect existing config: ${message}` };
    }
  }

  let backupPath: string | undefined;
  if (exists) {
    backupPath = `${path}.bak`;
    try {
      await fs.copyFile(path, backupPath);
    } catch (err) {
      backupPath = undefined;
      if (requireBackup) {
        const message = err instanceof Error ? err.message : String(err);
        const code = isPermissionError(err) ? 'PERMISSION_DENIED' : 'WRITE_FAILED';
        return { ok: false, code, message: `unable to back up existing config: ${message}` };
      }
    }
  }

  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  try {
    await fs.writeFile(tmpPath, json, { encoding: 'utf-8', mode: existingMode ?? 0o600 });
    if (existingMode !== undefined) {
      await fs.chmod(tmpPath, existingMode);
    }
    await fs.rename(tmpPath, path);
    return { ok: true, code: 'OK', backupPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { await fs.unlink(tmpPath); } catch {}
    if (isPermissionError(err)) {
      return { ok: false, code: 'PERMISSION_DENIED', message };
    }
    return { ok: false, code: 'WRITE_FAILED', message };
  }
}

export async function writeJsonConfig(args: WriteJsonConfigArgs): Promise<WriteJsonConfigResult> {
  const { path, keyPath, entry, dryRun, allowJsonc = false, requireBackup = false } = args;

  let existing: Record<string, unknown> = {};
  const exists = await fileReadable(path);
  if (exists) {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        existing = parseJsonObject(trimmed, allowJsonc);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = isPermissionError(err) ? 'PERMISSION_DENIED' : 'PARSE_ERROR';
      const action = code === 'PERMISSION_DENIED' ? 'read' : 'parse';
      return { ok: false, code, message: `unable to ${action} existing JSON: ${message}` };
    }
  }

  setAtPath(existing, keyPath, entry);
  const json = JSON.stringify(existing, null, 2) + '\n';

  if (dryRun) {
    return { ok: true, code: 'OK', dryRun: true };
  }

  return writeJsonFile(path, json, exists, requireBackup);
}

export async function removeJsonConfigEntry(
  args: RemoveJsonConfigEntryArgs,
): Promise<RemoveJsonConfigEntryResult> {
  const { path, keyPath, dryRun, allowJsonc = false, requireBackup = false } = args;
  const exists = await fileReadable(path);
  if (!exists) return { ok: true, code: 'OK', removed: false, ...(dryRun ? { dryRun: true } : {}) };

  let existing: Record<string, unknown>;
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const trimmed = raw.trim();
    existing = trimmed.length > 0 ? parseJsonObject(trimmed, allowJsonc) : {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = isPermissionError(err) ? 'PERMISSION_DENIED' : 'PARSE_ERROR';
    const action = code === 'PERMISSION_DENIED' ? 'read' : 'parse';
    return { ok: false, code, message: `unable to ${action} existing JSON: ${message}`, removed: false };
  }

  const removed = removeAtPath(existing, keyPath);
  if (!removed) return { ok: true, code: 'OK', removed: false, ...(dryRun ? { dryRun: true } : {}) };
  if (dryRun) return { ok: true, code: 'OK', removed: true, dryRun: true };

  const written = await writeJsonFile(path, JSON.stringify(existing, null, 2) + '\n', true, requireBackup);
  return { ...written, removed: written.ok };
}
