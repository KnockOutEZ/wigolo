import { execSync } from 'node:child_process';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('searxng');

const CONTAINER_NAME = 'wigolo-searxng';
const IMAGE = 'searxng/searxng:latest';

export function isContainerRunning(name: string): boolean {
  try {
    const result = execSync(
      `docker inspect --format '{{.State.Running}}' ${name}`,
      { stdio: 'pipe', encoding: 'utf-8' },
    ).trim();
    return result === 'true';
  } catch {
    return false;
  }
}

export function stopContainer(name: string): void {
  try {
    execSync(`docker stop ${name} && docker rm ${name}`, { stdio: 'pipe' });
    log.info('stopped Docker SearXNG container');
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
    const config = getConfig();
    this.port = config.searxngPort;

    stopContainer(CONTAINER_NAME);

    try {
      execSync(`docker run -d --name ${CONTAINER_NAME} -p ${this.port}:8080 ${IMAGE}`, {
        stdio: 'pipe',
      });
    } catch (err) {
      log.error('failed to start Docker SearXNG', { error: String(err) });
      this.port = null;
      return null;
    }

    const url = this.getUrl()!;
    const start = Date.now();
    while (Date.now() - start < 15000) {
      try {
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          log.info('Docker SearXNG started', { port: this.port });
          return url;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    log.error('Docker SearXNG failed to start');
    stopContainer(CONTAINER_NAME);
    this.port = null;
    return null;
  }

  async stop(): Promise<void> {
    stopContainer(CONTAINER_NAME);
    this.port = null;
  }
}
