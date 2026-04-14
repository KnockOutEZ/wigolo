import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SmartRouter, type HttpClient } from '../fetch/router.js';
import { BrowserPool } from '../fetch/browser-pool.js';
import { httpFetch } from '../fetch/http-client.js';
import { initDatabase, closeDatabase } from '../cache/db.js';
import { SearxngClient } from '../search/searxng.js';
import { DuckDuckGoEngine } from '../search/engines/duckduckgo.js';
import { BingEngine } from '../search/engines/bing.js';
import { StartpageEngine } from '../search/engines/startpage.js';
import { resolveSearchBackend, getBootstrapState } from '../searxng/bootstrap.js';
import { SearxngProcess } from '../searxng/process.js';
import { BackendStatus } from '../server/backend-status.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { startShell } from '../repl/shell.js';
import type { SearchEngine } from '../types.js';

const log = createLogger('cli');

export async function runShell(args: string[]): Promise<void> {
  const config = getConfig();
  const jsonMode = args.includes('--json');

  mkdirSync(config.dataDir, { recursive: true });
  initDatabase(join(config.dataDir, 'wigolo.db'));

  const httpClient: HttpClient = {
    fetch: (url, options) => httpFetch(url, options),
  };
  const browserPool = new BrowserPool();
  const router = new SmartRouter(httpClient, browserPool);
  const backendStatus = new BackendStatus();

  const searchEngines: SearchEngine[] = [
    new BingEngine(),
    new DuckDuckGoEngine(),
    new StartpageEngine(),
  ];

  let searxngProcess: SearxngProcess | null = null;

  try {
    const backend = await resolveSearchBackend();

    if (backend.type === 'external' && backend.url) {
      searchEngines.unshift(new SearxngClient(backend.url));
      backendStatus.markHealthy();
      log.info('shell using external SearXNG', { url: backend.url });
    } else if (backend.type === 'native' && backend.searxngPath) {
      const state = getBootstrapState(config.dataDir);
      if (state?.status === 'ready') {
        searxngProcess = new SearxngProcess(backend.searxngPath, config.dataDir, {
          onUnhealthy: (reason) => {
            backendStatus.markUnhealthy(reason);
            const idx = searchEngines.findIndex(e => e.name === 'searxng');
            if (idx >= 0) searchEngines.splice(idx, 1);
            log.warn('SearXNG unhealthy in shell', { reason });
          },
          onHealthy: () => {
            const url = searxngProcess?.getUrl();
            if (!url) return;
            backendStatus.markHealthy();
            if (!searchEngines.some(e => e.name === 'searxng')) {
              searchEngines.unshift(new SearxngClient(url));
            }
          },
        });
        const url = await searxngProcess.start();
        if (url) {
          searchEngines.unshift(new SearxngClient(url));
          backendStatus.markHealthy();
          log.info('SearXNG ready for shell', { url });
        }
      }
    }
  } catch (err) {
    log.warn('SearXNG setup failed for shell, using direct scraping', { error: String(err) });
    backendStatus.markUnhealthy(`SearXNG setup failed: ${String(err)}`);
  }

  try {
    await startShell(
      { router, engines: searchEngines, backendStatus },
      { jsonMode },
    );
  } finally {
    if (searxngProcess) await searxngProcess.stop();
    await browserPool.shutdown();
    closeDatabase();
  }
}
