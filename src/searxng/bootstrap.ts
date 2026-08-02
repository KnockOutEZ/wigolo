import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { isProcessAlive } from './process.js';
import { resolvePythonExe, venvBinPath, checkVenvModule, isMissingVenvModuleError, venvInstallHint } from '../python-env.js';
import { resolveContainerCli } from './docker.js';

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
          `Wait for it to finish, or force-recover: kill ${data.pid} && npx wigolo warmup --force`,
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
    const python = resolvePythonExe();
    const r = spawnSync(python, ['--version'], { stdio: 'pipe' });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
}

export function checkDockerAvailable(): boolean {
  // Any docker-compatible CLI works here — see resolveContainerCli() in
  // docker.ts for the full list (Docker Desktop, plain Docker Engine, Podman).
  return resolveContainerCli() !== null;
}

/**
 * SearXNG does not support running natively on Windows — upstream stdlib
 * imports (e.g. `searx/valkeydb.py`'s unconditional `import pwd`) assume a
 * POSIX host and crash on start regardless of the Python/venv setup being
 * otherwise correct. Upstream's guidance is to use the Docker image on
 * unsupported OSes (github.com/searxng/searxng/discussions/4029), so native
 * bootstrap should never be attempted on win32.
 */
export function isNativeSearxngSupported(platform: string = process.platform): boolean {
  return platform !== 'win32';
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

export function generateSettings(port: number, secretKey?: string): string {
  // Use a per-install random secret unless the caller pins one. The
  // hardcoded "wigolo-local-only" was discoverable via a settings.yml read;
  // with bind_address locked to 127.0.0.1 the risk was low, but a future
  // bind to a non-loopback interface or a misconfigured port-forward would
  // make a known secret an immediate auth-bypass vector.
  const secret = secretKey ?? randomBytes(32).toString('hex');
  return `use_default_settings: true

general:
  instance_name: "wigolo-searxng"
  debug: false

server:
  port: ${port}
  bind_address: "127.0.0.1"
  secret_key: "${secret}"

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

    if (retryWindowOpen && budgetRemaining && isNativeSearxngSupported() && checkPythonAvailable()) {
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

  if (!isNativeSearxngSupported()) {
    log.warn('native SearXNG is not supported on Windows (upstream is POSIX-only); use a container instead');
    const dockerCliAvailable = checkDockerAvailable();
    if (dockerCliAvailable && config.searxngMode !== 'native') {
      return { type: 'docker' };
    }
    setBootstrapState(dataDir, {
      status: 'no_runtime',
      error: dockerCliAvailable
        // CLI is present but SEARXNG_MODE=native is pinning us away from it —
        // the installation guidance below would be misleading here.
        ? 'SearXNG has no native Windows support (upstream is POSIX-only). A docker-compatible CLI ' +
          'was found on PATH, but SEARXNG_MODE=native is set — set SEARXNG_MODE=docker to use it, ' +
          'or unset WIGOLO_SEARCH to use the default core backend'
        : 'SearXNG has no native Windows support (upstream is POSIX-only) and no docker-compatible ' +
          'CLI was found on PATH — install Docker Desktop, Podman, or any other CLI that provides a ' +
          '`docker`/`podman` command, or unset searxng to use the default core backend',
    });
    return { type: 'scraping' };
  }

  if (checkPythonAvailable()) {
    return { type: 'native', searxngPath: join(dataDir, 'searxng') };
  }

  if (checkDockerAvailable()) {
    return { type: 'docker' };
  }

  log.warn('neither Python nor a docker-compatible CLI found — falling back to direct scraping');
  setBootstrapState(dataDir, { status: 'no_runtime', error: 'Python 3 and a docker-compatible CLI (docker/podman) were not found' });
  return { type: 'scraping' };
}

export async function bootstrapNativeSearxng(dataDir: string): Promise<void> {
  if (!isNativeSearxngSupported()) {
    throw new Error(
      'SearXNG has no native Windows support (upstream unconditionally imports POSIX-only ' +
      'stdlib modules, e.g. `import pwd` in searx/valkeydb.py, which does not exist on Windows). ' +
      'Install a docker-compatible container runtime and re-run — wigolo will run SearXNG in a ' +
      'container instead. Docker Desktop is not required: a plain Docker Engine, Podman (native ' +
      '`podman` binary or its `podman-docker` compatibility shim), or any other CLI providing a ' +
      '`docker`/`podman` command on PATH all work. ' +
      'See https://github.com/searxng/searxng/discussions/4029.',
    );
  }

  const release = acquireBootstrapLock(dataDir);
  const priorAttempts = getBootstrapState(dataDir)?.attempts ?? 0;
  // Captured from the proactive venv probe so the catch handler can build the
  // apt hint without re-spawning subprocesses to re-derive the Python version.
  let detectedPythonVersion: string | undefined;
  try {
    const searxngDir = join(dataDir, 'searxng');

    if (existsSync(searxngDir)) {
      log.info('removing previous SearXNG install before (re)bootstrap');
      rmSync(searxngDir, { recursive: true, force: true });
    }

    setBootstrapState(dataDir, { status: 'downloading', attempts: priorAttempts });
    log.info('bootstrapping SearXNG', { path: searxngDir });

    mkdirSync(searxngDir, { recursive: true });
    const pythonExe = resolvePythonExe();

    // Detect the missing-python3-venv case proactively so the failed state
    // carries actionable guidance instead of a cryptic ensurepip stderr. The
    // failed state then routes through resolveSearchBackend()'s docker→scraping
    // fallback, so search keeps working on the core backend.
    const venvCheck = checkVenvModule(pythonExe);
    detectedPythonVersion = venvCheck.pythonVersion;
    if (!venvCheck.available) {
      throw new BootstrapError({
        stderr: venvInstallHint(venvCheck.pythonVersion),
        exitCode: 1,
        command: `${pythonExe} -m venv ${join(searxngDir, 'venv')}`,
      });
    }

    runStep(pythonExe, ['-m', 'venv', join(searxngDir, 'venv')], { timeout: 60_000 });

    const pip = venvBinPath(dataDir, 'pip');
    const venvPython = venvBinPath(dataDir, 'python');
    // Windows refuses to let pip.exe overwrite itself while running (the
    // executable file is locked), so pip's own upgrade path must go through
    // `python -m pip` rather than invoking pip.exe directly.
    runStep(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], { timeout: 60_000 });

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
          // When the venv step failed with the recognizable python3-venv
          // symptom, surface the actionable apt hint as the message so doctor
          // and warmup show "run: sudo apt install pythonX.Y-venv" rather than
          // a raw ensurepip traceback.
          message: isMissingVenvModuleError(err.detail.stderr)
            ? venvInstallHint(detectedPythonVersion)
            : err.message,
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
