import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('searxng');

const PORT_RANGE_START = 8888;
const PORT_RANGE_END = 8899;
const HEALTH_TIMEOUT_MS = 10000;
const HEALTH_POLL_MS = 500;
const MAX_CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 60000;
const SHUTDOWN_GRACE_MS = 5000;

export function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;

    function tryPort() {
      if (port > PORT_RANGE_END) {
        reject(new Error(`No available port in range ${PORT_RANGE_START}-${PORT_RANGE_END}`));
        return;
      }
      const server = createNetServer();
      server.on('error', () => {
        port++;
        tryPort();
      });
      server.listen(port, () => {
        const addr = server.address();
        const foundPort = typeof addr === 'object' && addr ? addr.port : port;
        server.close(() => resolve(foundPort));
      });
    }

    tryPort();
  });
}

interface LockResult {
  acquired: boolean;
  existingPid?: number;
  existingPort?: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(dataDir: string): LockResult {
  const lockFile = join(dataDir, 'searxng.lock');

  if (existsSync(lockFile)) {
    try {
      const data = JSON.parse(readFileSync(lockFile, 'utf-8'));
      if (data.pid && isProcessAlive(data.pid)) {
        return { acquired: false, existingPid: data.pid, existingPort: data.port };
      }
      log.info('cleaning stale lock file', { stalePid: data.pid });
      unlinkSync(lockFile);
    } catch {
      unlinkSync(lockFile);
    }
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return { acquired: true };
}

export function releaseLock(dataDir: string): void {
  const lockFile = join(dataDir, 'searxng.lock');
  if (existsSync(lockFile)) {
    try { unlinkSync(lockFile); } catch {}
  }
  const portFile = join(dataDir, 'searxng.port');
  if (existsSync(portFile)) {
    try { unlinkSync(portFile); } catch {}
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

export class SearxngProcess {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private crashTimes: number[] = [];
  private stopped = false;

  constructor(
    private readonly searxngPath: string,
    private readonly dataDir: string,
  ) {}

  getUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  async start(): Promise<string | null> {
    const config = getConfig();
    const lock = acquireLock(this.dataDir);

    if (!lock.acquired) {
      if (lock.existingPort) {
        log.info('connecting to existing SearXNG instance', { port: lock.existingPort });
        this.port = lock.existingPort;
        return this.getUrl();
      }
      log.warn('could not acquire lock', { existingPid: lock.existingPid });
      return null;
    }

    try {
      this.port = await findAvailablePort(config.searxngPort);
    } catch (err) {
      log.error('no available port', { error: String(err) });
      releaseLock(this.dataDir);
      return null;
    }

    const settingsPath = join(this.searxngPath, 'settings.yml');
    const pythonBin = join(this.searxngPath, 'venv', 'bin', 'python');

    this.child = spawn(pythonBin, ['-m', 'searx.webapp'], {
      env: { ...process.env, SEARXNG_SETTINGS_PATH: settingsPath },
      stdio: 'pipe',
    });

    writeFileSync(join(this.dataDir, 'searxng.port'), String(this.port));
    // Update lock file with the resolved port so other instances can connect
    writeFileSync(
      join(this.dataDir, 'searxng.lock'),
      JSON.stringify({ pid: process.pid, port: this.port, startedAt: new Date().toISOString() }),
    );

    const url = this.getUrl()!;
    const healthy = await waitForHealth(url, HEALTH_TIMEOUT_MS);

    if (!healthy) {
      log.error('SearXNG failed to start within timeout');
      await this.stop();
      return null;
    }

    this.monitorCrashes();
    log.info('SearXNG started', { port: this.port, url });
    return url;
  }

  private monitorCrashes(): void {
    if (!this.child) return;

    this.child.on('exit', (code) => {
      if (this.stopped) return;

      log.warn('SearXNG process exited unexpectedly', { code });
      this.crashTimes.push(Date.now());

      const cutoff = Date.now() - CRASH_WINDOW_MS;
      this.crashTimes = this.crashTimes.filter(t => t > cutoff);

      if (this.crashTimes.length >= MAX_CRASH_RESTARTS) {
        log.error('too many crashes, giving up on SearXNG', { crashes: this.crashTimes.length });
        releaseLock(this.dataDir);
        return;
      }

      const backoff = Math.min(1000 * Math.pow(2, this.crashTimes.length - 1), 30000);
      log.info('restarting SearXNG after backoff', { backoffMs: backoff });
      setTimeout(() => {
        if (!this.stopped) this.start();
      }, backoff);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.child) {
      this.child.kill('SIGTERM');

      await Promise.race([
        new Promise<void>((resolve) => this.child!.on('exit', resolve)),
        new Promise<void>((resolve) => setTimeout(() => {
          this.child?.kill('SIGKILL');
          resolve();
        }, SHUTDOWN_GRACE_MS)),
      ]);

      this.child = null;
    }

    releaseLock(this.dataDir);
    this.port = null;
  }
}
