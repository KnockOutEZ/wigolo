import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { isProcessAlive } from './process.js';

const log = createLogger('searxng');

export interface BootstrapState {
  status: 'downloading' | 'ready' | 'failed' | 'no_runtime';
  searxngPath?: string;
  attempts?: number;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  lastError?: {
    message: string;
    stderr: string;
    exitCode: number | null;
    command: string;
    timestamp: string;
  };
  /** @deprecated legacy field; read-only for back-compat. Never written by new code. */
  error?: string;
}

export function backoffSchedule(attempt: number): number | null {
  const config = getConfig();
  const max = config.bootstrapMaxAttempts;
  const schedule = config.bootstrapBackoffSeconds;
  if (attempt < 1 || attempt > max) return null;
  return schedule[attempt - 1] ?? null;
}

export interface BootstrapErrorDetail {
  stderr: string;
  exitCode: number | null;
  command: string;
}

export class BootstrapError extends Error {
  constructor(public readonly detail: BootstrapErrorDetail) {
    super(`bootstrap step failed: ${detail.command} (exit ${detail.exitCode})`);
    this.name = 'BootstrapError';
  }
}

export function runStep(command: string, args: string[], opts: { timeout: number }): void {
  const result = spawnSync(command, args, { encoding: 'utf-8', timeout: opts.timeout });
  if (result.status !== 0 || result.error) {
    throw new BootstrapError({
      stderr: result.stderr || String(result.error ?? ''),
      exitCode: result.status,
      command: `${command} ${args.join(' ')}`,
    });
  }
}

export function acquireBootstrapLock(dataDir: string): () => void {
  const lockFile = join(dataDir, 'bootstrap.lock');

  if (existsSync(lockFile)) {
    let stale = false;
    try {
      const data = JSON.parse(readFileSync(lockFile, 'utf-8')) as { pid?: number };
      if (data.pid && isProcessAlive(data.pid)) {
        throw new Error(
          `SearXNG bootstrap already in progress (pid ${data.pid}). ` +
          `Wait for it to finish, or force-recover: kill ${data.pid} && npx @staticn0va/wigolo warmup --force`,
        );
      }
      stale = true;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('SearXNG bootstrap already in progress')) throw err;
      stale = true; // unparseable → treat as stale
    }
    if (stale) {
      log.info('wiping stale bootstrap lock');
      try { unlinkSync(lockFile); } catch {}
    }
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  return function release(): void {
    try { unlinkSync(lockFile); } catch {}
  };
}

export interface WaitForBootstrapOpts {
  timeoutMs: number;
  intervalMs: number;
}

export async function waitForBootstrap(dataDir: string, opts: WaitForBootstrapOpts): Promise<'ready' | 'failed'> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const state = getBootstrapState(dataDir);
    if (state?.status === 'ready') return 'ready';
    if (state?.status === 'failed') return 'failed';
    if (state?.status === 'no_runtime') return 'failed';
    await new Promise(r => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`waitForBootstrap timed out after ${opts.timeoutMs}ms`);
}

export interface BackendResolution {
  type: 'external' | 'native' | 'docker' | 'scraping';
  url?: string;
  searxngPath?: string;
}

export function checkPythonAvailable(): boolean {
  try {
    execSync('python3 --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function checkDockerAvailable(): boolean {
  try {
    execSync('docker --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function getBootstrapState(dataDir: string): BootstrapState | null {
  const stateFile = join(dataDir, 'state.json');
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    return null;
  }
}

export function setBootstrapState(dataDir: string, state: BootstrapState): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state));
}

export function generateSettings(port: number): string {
  return `use_default_settings: true

general:
  instance_name: "wigolo-searxng"
  debug: false

server:
  port: ${port}
  bind_address: "127.0.0.1"
  secret_key: "wigolo-local-only"

search:
  safe_search: 0
  default_lang: "en"
  formats:
    - html
    - json

engines:
  - name: google
    engine: google
    shortcut: g
  - name: bing
    engine: bing
    shortcut: b
  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
  - name: brave
    engine: brave
    shortcut: br

ui:
  default_theme: simple
`;
}

export async function resolveSearchBackend(): Promise<BackendResolution> {
  const config = getConfig();

  if (config.searxngUrl) {
    log.info('using external SearXNG', { url: config.searxngUrl });
    return { type: 'external', url: config.searxngUrl };
  }

  const dataDir = config.dataDir;
  const state = getBootstrapState(dataDir);

  if (state?.status === 'ready' && state.searxngPath) {
    log.info('SearXNG already bootstrapped', { path: state.searxngPath });
    return { type: 'native', searxngPath: state.searxngPath };
  }

  if (state?.status === 'downloading') {
    log.warn('previous SearXNG download was interrupted; bootstrapNativeSearxng will clean up under lock');
  }

  if (state?.status === 'failed') {
    const attempts = state.attempts ?? 1;
    const nextRetryAt = state.nextRetryAt ? new Date(state.nextRetryAt) : new Date(0);
    const retryWindowOpen = new Date() >= nextRetryAt;
    const budgetRemaining = attempts < config.bootstrapMaxAttempts;

    if (retryWindowOpen && budgetRemaining && checkPythonAvailable()) {
      log.info('SearXNG bootstrap retry window reached', { attempts, nextRetryAt: state.nextRetryAt });
      return { type: 'native', searxngPath: join(dataDir, 'searxng') };
    }

    log.warn('SearXNG bootstrap stuck', {
      attempts,
      nextRetryAt: state.nextRetryAt,
      error: state.lastError?.message ?? state.error,
    });
    if (checkDockerAvailable() && config.searxngMode !== 'native') {
      return { type: 'docker' };
    }
    return { type: 'scraping' };
  }

  if (state?.status === 'no_runtime') {
    log.warn('SearXNG runtime not found, using fallback', { error: state.error });
    if (checkDockerAvailable() && config.searxngMode !== 'native') {
      return { type: 'docker' };
    }
    return { type: 'scraping' };
  }

  if (checkPythonAvailable()) {
    return { type: 'native', searxngPath: join(dataDir, 'searxng') };
  }

  if (checkDockerAvailable()) {
    return { type: 'docker' };
  }

  log.warn('neither Python nor Docker found — falling back to direct scraping');
  setBootstrapState(dataDir, { status: 'no_runtime', error: 'Python 3 and Docker not found' });
  return { type: 'scraping' };
}

export async function bootstrapNativeSearxng(dataDir: string): Promise<void> {
  const release = acquireBootstrapLock(dataDir);
  const priorAttempts = getBootstrapState(dataDir)?.attempts ?? 0;
  try {
    const searxngDir = join(dataDir, 'searxng');

    if (existsSync(searxngDir)) {
      log.info('removing previous SearXNG install before (re)bootstrap');
      rmSync(searxngDir, { recursive: true, force: true });
    }

    setBootstrapState(dataDir, { status: 'downloading' });
    log.info('bootstrapping SearXNG', { path: searxngDir });

    mkdirSync(searxngDir, { recursive: true });
    runStep('python3', ['-m', 'venv', join(searxngDir, 'venv')], { timeout: 60_000 });

    const pip = join(searxngDir, 'venv', 'bin', 'pip');
    runStep(pip, ['install', '--upgrade', 'pip', 'setuptools', 'wheel'], { timeout: 60_000 });

    const repoDir = join(searxngDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const tarPath = join(searxngDir, 'searxng.tar.gz');

    log.info('downloading SearXNG source');
    const response = await fetch('https://github.com/searxng/searxng/archive/refs/heads/master.tar.gz');
    if (!response.ok) {
      throw new BootstrapError({
        stderr: `SearXNG download failed: ${response.status} ${response.statusText}`,
        exitCode: response.status,
        command: 'fetch searxng.tar.gz',
      });
    }
    writeFileSync(tarPath, Buffer.from(await response.arrayBuffer()));
    runStep('tar', ['xzf', tarPath, '--strip-components=1', '-C', repoDir], { timeout: 60_000 });

    runStep(pip, ['install', '-r', join(repoDir, 'requirements.txt')], { timeout: 300_000 });
    runStep(pip, ['install', '--no-build-isolation', '--no-deps', repoDir], { timeout: 120_000 });

    const config = getConfig();
    const settings = generateSettings(config.searxngPort);
    writeFileSync(join(searxngDir, 'settings.yml'), settings);

    setBootstrapState(dataDir, { status: 'ready', searxngPath: searxngDir });
    log.info('SearXNG bootstrap complete');
  } catch (err) {
    const attempts = priorAttempts + 1;
    const backoffSecs = backoffSchedule(attempts);
    const nextRetryAt = backoffSecs === null
      ? undefined
      : new Date(Date.now() + backoffSecs * 1000).toISOString();

    const lastError = err instanceof BootstrapError
      ? {
          message: err.message,
          stderr: err.detail.stderr,
          exitCode: err.detail.exitCode,
          command: err.detail.command,
          timestamp: new Date().toISOString(),
        }
      : {
          message: err instanceof Error ? err.message : String(err),
          stderr: '',
          exitCode: null,
          command: '',
          timestamp: new Date().toISOString(),
        };

    setBootstrapState(dataDir, {
      status: 'failed',
      attempts,
      lastAttemptAt: new Date().toISOString(),
      nextRetryAt,
      lastError,
    });
    log.error('SearXNG bootstrap failed', { attempts, nextRetryAt, error: lastError.message });
    throw err;
  } finally {
    release();
  }
}
