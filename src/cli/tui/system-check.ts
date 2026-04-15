import { spawnSync } from 'node:child_process';
import { statfs } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const statfsAsync = promisify(statfs);

export interface CheckResult {
  ok: boolean;
  version?: string;
  message?: string;
}

export interface PythonCheckResult extends CheckResult {
  binary?: 'python3' | 'python';
}

export interface DiskCheckResult extends CheckResult {
  freeMb?: number;
}

export interface SystemCheckResult {
  node: CheckResult;
  python: PythonCheckResult;
  docker: CheckResult;
  disk: DiskCheckResult;
  hardFailure: boolean;
}

const MIN_NODE_MAJOR = 20;
const MIN_FREE_MB = 500;

function parseSemver(raw: string): { major: number; minor: number; patch: number } | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
  };
}

export function checkNode(): CheckResult {
  const parsed = parseSemver(process.version);
  if (!parsed) {
    return { ok: false, message: `unable to parse Node version '${process.version}'` };
  }
  const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (parsed.major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      version,
      message: `wigolo requires Node 20 or newer (found ${version})`,
    };
  }
  return { ok: true, version };
}

function runPython(binary: 'python3' | 'python'): PythonCheckResult | null {
  const r = spawnSync(binary, ['--version'], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) return null;
  const raw = (r.stdout || r.stderr || '').trim();
  const parsed = parseSemver(raw);
  if (!parsed) {
    return { ok: false, binary, message: `unable to parse Python version from '${raw}'` };
  }
  const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (parsed.major < 3) {
    return {
      ok: false,
      binary,
      version,
      message: `wigolo requires Python 3 (found ${version})`,
    };
  }
  return { ok: true, binary, version };
}

export function checkPython(): PythonCheckResult {
  const viaPy3 = runPython('python3');
  if (viaPy3) return viaPy3;
  const viaPy = runPython('python');
  if (viaPy) return viaPy;
  return {
    ok: false,
    message: 'Python 3 not found. Install: https://python.org/downloads or `brew install python3`',
  };
}

export function checkDocker(): CheckResult {
  const r = spawnSync('docker', ['--version'], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    return { ok: false };
  }
  const raw = (r.stdout || '').trim();
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return { ok: true, version: m?.[1] };
}

export async function checkDiskSpace(path: string = homedir()): Promise<DiskCheckResult> {
  try {
    const stats = await statfsAsync(path);
    const freeBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
    const freeMb = Number(freeBytes / 1024n / 1024n);
    if (freeMb < MIN_FREE_MB) {
      return {
        ok: false,
        freeMb,
        message: `only ${freeMb} MB free (need ~${MIN_FREE_MB} MB)`,
      };
    }
    return { ok: true, freeMb };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `unable to check disk space: ${message}` };
  }
}

export async function runSystemCheck(): Promise<SystemCheckResult> {
  const node = checkNode();
  const python = checkPython();
  const docker = checkDocker();
  const disk = await checkDiskSpace();
  const hardFailure = !node.ok || !python.ok;
  return { node, python, docker, disk, hardFailure };
}
