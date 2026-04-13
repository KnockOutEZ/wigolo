import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
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
    log.warn('previous SearXNG download was interrupted, cleaning up');
    const searxngDir = join(dataDir, 'searxng');
    try { rmSync(searxngDir, { recursive: true, force: true }); } catch {}
  }

  if (state?.status === 'failed' || state?.status === 'no_runtime') {
    log.warn('SearXNG bootstrap previously failed', { error: state.error });
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
  const searxngDir = join(dataDir, 'searxng');

  setBootstrapState(dataDir, { status: 'downloading' });
  log.info('bootstrapping SearXNG', { path: searxngDir });

  try {
    mkdirSync(searxngDir, { recursive: true });
    execSync(`python3 -m venv ${join(searxngDir, 'venv')}`, { stdio: 'pipe' });

    const pip = join(searxngDir, 'venv', 'bin', 'pip');
    execSync(`${pip} install --upgrade pip setuptools wheel`, { stdio: 'pipe', timeout: 60000 });

    // Download SearXNG tarball and install with deps (pip install from zip fails due to build-time imports)
    const repoDir = join(searxngDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const tarPath = join(searxngDir, 'searxng.tar.gz');

    log.info('downloading SearXNG source');
    const response = await fetch('https://github.com/searxng/searxng/archive/refs/heads/master.tar.gz');
    if (!response.ok) throw new Error(`SearXNG download failed: ${response.status} ${response.statusText}`);
    writeFileSync(tarPath, Buffer.from(await response.arrayBuffer()));
    execSync(`tar xzf ${tarPath} --strip-components=1 -C ${repoDir}`, { stdio: 'pipe' });

    execSync(`${pip} install -r ${join(repoDir, 'requirements.txt')}`, { stdio: 'pipe', timeout: 300000 });
    execSync(`${pip} install --no-build-isolation --no-deps ${repoDir}`, { stdio: 'pipe', timeout: 120000 });

    const config = getConfig();
    const settings = generateSettings(config.searxngPort);
    writeFileSync(join(searxngDir, 'settings.yml'), settings);

    setBootstrapState(dataDir, { status: 'ready', searxngPath: searxngDir });
    log.info('SearXNG bootstrap complete');
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('SearXNG bootstrap failed', { error });
    setBootstrapState(dataDir, { status: 'failed', error });
    throw err;
  }
}
