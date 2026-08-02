import { execSync, execFileSync } from 'node:child_process';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('searxng');

const CONTAINER_NAME = 'wigolo-searxng';
const IMAGE = 'searxng/searxng:latest';

// wigolo shells out to whichever `docker`-compatible CLI is on PATH — it
// never talks to the Docker Engine API directly, so any CLI that implements
// the same `run`/`inspect`/`stop`/`rm` subcommands works: Docker Desktop,
// a bare Docker Engine (e.g. installed inside WSL2), or Podman (either via
// its native `podman` binary or the `podman-docker` compatibility shim).
// Docker Desktop is not required.
const CONTAINER_CLI_CANDIDATES = ['docker', 'podman'] as const;

let _resolvedContainerCli: string | null | undefined;

/**
 * Detects the first available docker-compatible CLI on PATH, preferring
 * `docker` (covers Docker Desktop, plain Docker Engine, and Podman's
 * `podman-docker` shim) and falling back to the native `podman` binary.
 * Memoized — the available CLI does not change within a process.
 */
export function resolveContainerCli(): string | null {
  if (_resolvedContainerCli !== undefined) return _resolvedContainerCli;
  for (const cli of CONTAINER_CLI_CANDIDATES) {
    try {
      execSync(`${cli} --version`, { stdio: 'pipe', timeout: 5_000 });
      return (_resolvedContainerCli = cli);
    } catch {
      // try next candidate
    }
  }
  return (_resolvedContainerCli = null);
}

/** Test-only: clear the memoized CLI so platform-mocked tests re-resolve. */
export function __resetResolvedContainerCli(): void {
  _resolvedContainerCli = undefined;
}

export function isContainerRunning(name: string): boolean {
  const cli = resolveContainerCli();
  if (!cli) return false;
  try {
    const result = execFileSync(
      cli,
      ['inspect', '--format', '{{.State.Running}}', '--', name],
      { stdio: 'pipe', encoding: 'utf-8' },
    ).trim();
    return result === 'true';
  } catch {
    return false;
  }
}

export function stopContainer(name: string): void {
  const cli = resolveContainerCli();
  if (!cli) return;
  try {
    execFileSync(cli, ['stop', '--', name], { stdio: 'pipe' });
    execFileSync(cli, ['rm', '--', name], { stdio: 'pipe' });
    log.info('stopped SearXNG container', { cli });
  } catch {
    log.debug('container was not running');
  }
}

export class DockerSearxng {
  private port: number | null = null;

  getUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  async start(): Promise<string | null> {
    const cli = resolveContainerCli();
    if (!cli) {
      log.error('no docker-compatible CLI found (tried: docker, podman)');
      return null;
    }

    const config = getConfig();
    this.port = config.searxngPort;

    stopContainer(CONTAINER_NAME);

    try {
      execFileSync(
        cli,
        [
          'run',
          '-d',
          '--name', CONTAINER_NAME,
          '-p', `${this.port}:8080`,
          IMAGE,
        ],
        { stdio: 'pipe' },
      );
    } catch (err) {
      log.error('failed to start SearXNG container', { cli, error: String(err) });
      this.port = null;
      return null;
    }

    const url = this.getUrl()!;
    const start = Date.now();
    while (Date.now() - start < 15000) {
      try {
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          log.info('SearXNG container started', { cli, port: this.port });
          return url;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    log.error('SearXNG container failed to start', { cli });
    stopContainer(CONTAINER_NAME);
    this.port = null;
    return null;
  }

  async stop(): Promise<void> {
    stopContainer(CONTAINER_NAME);
    this.port = null;
  }
}
