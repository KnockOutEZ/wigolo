import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBootstrapState, type BootstrapState } from '../searxng/bootstrap.js';
import { isProcessAlive } from '../searxng/process.js';

function out(line = ''): void { process.stderr.write(`${line}\n`); }

function checkPython(): { ok: boolean; version?: string } {
  const r = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
  if (r.status !== 0 || r.error) return { ok: false };
  const match = (r.stdout || r.stderr || '').match(/Python (\d+\.\d+\.\d+)/);
  return { ok: true, version: match?.[1] };
}

function checkDocker(): { ok: boolean; version?: string } {
  const r = spawnSync('docker', ['--version'], { encoding: 'utf-8' });
  if (r.status !== 0 || r.error) return { ok: false };
  return { ok: true, version: (r.stdout || '').trim() };
}

function checkPlaywright(): { installed: boolean; version?: string; browsers: { chromium: boolean; firefox: boolean; webkit: boolean } } {
  let installed = false;
  let version: string | undefined;
  try {
    const r = spawnSync('npx', ['playwright', '--version'], { encoding: 'utf-8', timeout: 5000 });
    if (r.status === 0) {
      installed = true;
      const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
      version = m?.[1];
    }
  } catch { /* ignore */ }
  // Browser detection — light check
  const probe = (browser: string): boolean => {
    const r = spawnSync('npx', ['playwright', 'install', '--dry-run', browser], { encoding: 'utf-8', timeout: 5000 });
    return r.status === 0 && !/is not installed/i.test(r.stdout + r.stderr);
  };
  return { installed, version, browsers: { chromium: probe('chromium'), firefox: probe('firefox'), webkit: probe('webkit') } };
}

function checkPyPackage(name: string): { ok: boolean; version?: string } {
  const r = spawnSync('python3', ['-c', `import ${name}; print(${name}.__version__)`], { encoding: 'utf-8' });
  if (r.status !== 0 || r.error) return { ok: false };
  return { ok: true, version: (r.stdout || '').trim() };
}

function humanRetry(nextRetryAt?: string): string {
  if (!nextRetryAt) return 'not scheduled';
  const when = new Date(nextRetryAt);
  const mins = Math.round((when.getTime() - Date.now()) / 60_000);
  if (mins < 0) return `${nextRetryAt} (ready now)`;
  if (mins < 60) return `${nextRetryAt} (in ${mins} minutes)`;
  const hrs = Math.round(mins / 60);
  return `${nextRetryAt} (in ${hrs} hours)`;
}

/**
 * Exit code contract:
 * - 0 when all required components OK, or only optional packages (Trafilatura/FlashRank) missing.
 * - 1 when any required component is degraded: Python missing, Playwright browsers missing,
 *   SearXNG bootstrap failed/no_runtime, or SearXNG process supposed to be up but isn't.
 */
export async function runDoctor(dataDir: string): Promise<number> {
  let degraded = false;

  out(`[wigolo doctor] Data dir:        ${dataDir}`);
  out('');

  const py = checkPython();
  const dk = checkDocker();
  out('[wigolo doctor] Runtime:');
  out(`  Python 3:      ${py.ok ? `available (${py.version ?? 'unknown'})` : 'not available'}`);
  out(`  Docker:        ${dk.ok ? `available (${dk.version})` : 'not available'}`);
  if (!py.ok && !dk.ok) degraded = true;

  out('');
  const pw = checkPlaywright();
  out('[wigolo doctor] Playwright:');
  out(`  Installation:  ${pw.installed ? `installed${pw.version ? ` (v${pw.version})` : ''}` : 'not installed'}`);
  out(`  Browsers:      chromium ${pw.browsers.chromium ? 'OK' : 'missing'}  firefox ${pw.browsers.firefox ? 'OK' : 'missing'}  webkit ${pw.browsers.webkit ? 'OK' : 'missing'}`);
  if (!pw.installed || !pw.browsers.chromium) degraded = true;

  out('');
  const traf = checkPyPackage('trafilatura');
  const flash = checkPyPackage('flashrank');
  out('[wigolo doctor] Optional Python packages:');
  out(`  Trafilatura:   ${traf.ok ? `installed (v${traf.version})` : 'not installed'}`);
  out(`  FlashRank:     ${flash.ok ? `installed (v${flash.version})` : 'not installed'}`);

  out('');
  const state = getBootstrapState(dataDir) as BootstrapState | null;
  out('[wigolo doctor] SearXNG install:');
  if (!state) {
    out('  status:        not bootstrapped — run `npx @staticn0va/wigolo warmup`');
    degraded = true;
  } else if (state.status === 'ready') {
    out(`  status:        ready`);
    out(`  path:          ${state.searxngPath ?? 'unknown'}`);
  } else {
    out(`  status:        ${state.status}`);
    if (state.attempts !== undefined) out(`  attempts:      ${state.attempts} / 3`);
    if (state.lastAttemptAt) out(`  lastAttemptAt: ${state.lastAttemptAt}`);
    if (state.nextRetryAt || state.status === 'failed') out(`  nextRetryAt:   ${humanRetry(state.nextRetryAt)}`);
    if (state.lastError?.command) out(`  command:       ${state.lastError.command}`);
    if (state.lastError?.exitCode !== undefined) out(`  exit code:     ${state.lastError.exitCode}`);
    if (state.lastError?.message) out(`  message:       ${state.lastError.message}`);
    if (state.lastError?.stderr) {
      out('  stderr:');
      for (const line of state.lastError.stderr.split('\n').slice(0, 20)) out(`    ${line}`);
    }
    degraded = true;
  }

  out('');
  const lockPath = join(dataDir, 'searxng.lock');
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number; port?: number };
      if (lock.pid && isProcessAlive(lock.pid)) {
        out(`[wigolo doctor] SearXNG process:  running (pid ${lock.pid}, port ${lock.port ?? '?'})`);
      } else {
        out('[wigolo doctor] SearXNG process:  lock exists but pid is dead');
        if (state?.status === 'ready') degraded = true;
      }
    } catch {
      out('[wigolo doctor] SearXNG process:  lock file unparseable');
    }
  } else {
    out('[wigolo doctor] SearXNG process:  not running');
    if (state?.status === 'ready') degraded = true;
  }

  if (state?.status === 'failed') {
    out('');
    out('[wigolo doctor] Recovery:');
    if (state.nextRetryAt) out(`  - Wait until next auto-retry (${humanRetry(state.nextRetryAt)}), or`);
    out(`  - Force retry now: npx @staticn0va/wigolo warmup --force`);
  }

  out('');
  out(`[wigolo doctor] Overall: ${degraded ? 'DEGRADED' : 'OK'}`);
  return degraded ? 1 : 0;
}
