import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

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
}

export interface WriteJsonConfigResult {
  ok: boolean;
  code: WriteCode;
  message?: string;
  dryRun?: boolean;
  backupPath?: string;
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

async function fileReadable(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonConfig(args: WriteJsonConfigArgs): Promise<WriteJsonConfigResult> {
  const { path, keyPath, entry, dryRun } = args;

  let existing: Record<string, unknown> = {};
  const exists = await fileReadable(path);
  if (exists) {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        } else {
          return { ok: false, code: 'PARSE_ERROR', message: 'existing config is not a JSON object' };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'PARSE_ERROR', message: `unable to parse existing JSON: ${message}` };
    }
  }

  setAtPath(existing, keyPath, entry);
  const json = JSON.stringify(existing, null, 2) + '\n';

  if (dryRun) {
    return { ok: true, code: 'OK', dryRun: true };
  }

  try {
    await fs.mkdir(dirname(path), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/EACCES|EPERM/.test(message)) {
      return { ok: false, code: 'PERMISSION_DENIED', message };
    }
    return { ok: false, code: 'MKDIR_FAILED', message };
  }

  let backupPath: string | undefined;
  if (exists) {
    backupPath = `${path}.bak`;
    try {
      await fs.copyFile(path, backupPath);
    } catch {
      backupPath = undefined;
    }
  }

  const tmpPath = `${path}.tmp`;
  try {
    await fs.writeFile(tmpPath, json, 'utf-8');
    await fs.rename(tmpPath, path);
    return { ok: true, code: 'OK', backupPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { await fs.unlink(tmpPath); } catch {}
    if (/EACCES|EPERM/.test(message)) {
      return { ok: false, code: 'PERMISSION_DENIED', message };
    }
    return { ok: false, code: 'WRITE_FAILED', message };
  }
}
