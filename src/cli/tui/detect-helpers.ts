import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

export function binaryInPath(name: string): string | null {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, [name], { encoding: 'utf-8', timeout: 3000 });
    if (r.error || r.status !== 0) return null;
    const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}

export function dirExists(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function fileExists(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function getHome(): string {
  return homedir();
}

export function getCwd(): string {
  return process.cwd();
}
