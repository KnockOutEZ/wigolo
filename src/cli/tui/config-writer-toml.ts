import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseToml, stringify as stringifyToml, type JsonMap } from '@iarna/toml';
import type { WriteCode } from './config-writer-json.js';

export interface WriteTomlConfigArgs {
  path: string;
  tablePath: string[];
  entry: Record<string, unknown>;
  dryRun?: boolean;
}

export interface WriteTomlConfigResult {
  ok: boolean;
  code: WriteCode;
  message?: string;
  dryRun?: boolean;
  backupPath?: string;
}

function setAtPath(obj: JsonMap, tablePath: string[], value: unknown): void {
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < tablePath.length - 1; i++) {
    const k = tablePath[i];
    if (typeof cursor[k] !== 'object' || cursor[k] === null || Array.isArray(cursor[k])) {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[tablePath[tablePath.length - 1]] = value;
}

async function fileReadable(path: string): Promise<boolean> {
  try { await fs.access(path); return true; } catch { return false; }
}

export async function writeTomlConfig(args: WriteTomlConfigArgs): Promise<WriteTomlConfigResult> {
  const { path, tablePath, entry, dryRun } = args;

  let existing: JsonMap = {};
  const exists = await fileReadable(path);
  if (exists) {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      if (raw.trim().length > 0) {
        existing = parseToml(raw);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'PARSE_ERROR', message: `unable to parse existing TOML: ${message}` };
    }
  }

  setAtPath(existing, tablePath, entry as JsonMap);
  let serialized: string;
  try {
    serialized = stringifyToml(existing);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'WRITE_FAILED', message };
  }

  if (dryRun) {
    return { ok: true, code: 'OK', dryRun: true };
  }

  try {
    await fs.mkdir(dirname(path), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/EACCES|EPERM/.test(message)) return { ok: false, code: 'PERMISSION_DENIED', message };
    return { ok: false, code: 'MKDIR_FAILED', message };
  }

  let backupPath: string | undefined;
  if (exists) {
    backupPath = `${path}.bak`;
    try { await fs.copyFile(path, backupPath); } catch { backupPath = undefined; }
  }

  const tmpPath = `${path}.tmp`;
  try {
    await fs.writeFile(tmpPath, serialized, 'utf-8');
    await fs.rename(tmpPath, path);
    return { ok: true, code: 'OK', backupPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { await fs.unlink(tmpPath); } catch {}
    if (/EACCES|EPERM/.test(message)) return { ok: false, code: 'PERMISSION_DENIED', message };
    return { ok: false, code: 'WRITE_FAILED', message };
  }
}
