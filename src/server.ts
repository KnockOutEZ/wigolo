import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SmartRouter, type HttpClient } from './fetch/router.js';
import { MultiBrowserPool } from './fetch/browser-pool.js';
import { closeDaemonBrowser } from './fetch/playwright-tier.js';
import { httpFetch } from './fetch/http-client.js';
import { initDatabase, closeDatabase } from './cache/db.js';
import { handleFetch } from './tools/fetch.js';
import { handleSearch } from './tools/search.js';
import { buildSearchContentBlocks } from './server/search-response.js';
import { handleCrawl } from './tools/crawl.js';
import { handleCache } from './tools/cache.js';
import { handleExtract } from './tools/extract.js';
import { handleFindSimilar } from './tools/find-similar.js';
import { handleResearch } from './tools/research.js';
import { handleAgent } from './tools/agent.js';
import { handleDiff } from './tools/diff.js';
import { handleWatch } from './tools/watch.js';
import { scheduleOverdueCheck } from './watch/scheduler.js';
import type { SamplingCapableServer } from './search/sampling.js';
import { SearxngClient } from './search/searxng.js';
import { DuckDuckGoEngine } from './search/engines/duckduckgo.js';
import { BingEngine } from './search/engines/bing.js';
import { resolveSearchBackend, getBootstrapState } from './searxng/bootstrap.js';
import { searxngConfigured, searxngBackendAvailable } from './searxng/enabled.js';
import { SearxngProcess } from './searxng/process.js';
import { DockerSearxng } from './searxng/docker.js';
import { BackendStatus } from './server/backend-status.js';
import { maybeEagerWarmup, warmEngines } from './server/warmup-on-start.js';
import { getEmbeddingService, resetEmbeddingService } from './embedding/embed.js';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import {
  createMcpServer as createControlPlaneServer,
} from './server/control.js';
import { loadPlugins } from './plugins/loader.js';
import { PluginRegistry } from './plugins/registry.js';
import { registerExtractor } from './extraction/pipeline.js';
import type { FetchInput, SearchInput, SearchEngine, CrawlInput, CacheInput, ExtractInput, FindSimilarInput, ResearchInput, AgentInput, ProgressCallback, WatchJobInput } from './types.js';
import type { CallToolRequest, CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

const log = createLogger('server');

export interface Subsystems {
  searchEngines: SearchEngine[];
  browserPool: MultiBrowserPool;
  router: SmartRouter;
  backendStatus: BackendStatus;
  pluginRegistry: PluginRegistry;
  shutdown: () => Promise<void>;
  bootstrapSearxng: () => Promise<void>;
}

export async function initSubsystems(): Promise<Subsystems> {
  const config = getConfig();

  mkdirSync(config.dataDir, { recursive: true });
  let browserPool!: MultiBrowserPool;
  let router!: SmartRouter;
  let backendStatus!: BackendStatus;
  let searchEngines!: SearchEngine[];
  let pluginRegistry!: PluginRegistry;

  // Initialize embedding service: provisions the vector store, runs the
  // legacy-embedding migration, and surfaces sqlite-vec failures. It does NOT
  // load the embedding model — that happens lazily on first embed/find_similar
  // via ensureProviderReady(), keeping idle footprint low (D2).
  try {
    initDatabase(join(config.dataDir, 'wigolo.db'));
    await getEmbeddingService().init();
    const httpClient: HttpClient = {
      fetch: (url, options) => httpFetch(url, options),
    };
    browserPool = new MultiBrowserPool({
      browserTypes: config.browserTypes,
      selectionStrategy: 'round-robin',
    });
    router = new SmartRouter(httpClient, browserPool);
    backendStatus = new BackendStatus();
    searchEngines = [new BingEngine(), new DuckDuckGoEngine()];
    pluginRegistry = new PluginRegistry();
  } catch (err) {
    const rollback = await Promise.allSettled([
      browserPool?.shutdown(),
      closeDaemonBrowser(),
      Promise.resolve().then(() => resetEmbeddingService()),
      Promise.resolve().then(() => closeDatabase()),
    ]);
    const rollbackFailures = rollback.filter((result) => result.status === 'rejected');
    if (rollbackFailures.length > 0) {
      log.error('runtime initialization rollback failed', { count: rollbackFailures.length });
      throw new AggregateError(
        [err, ...rollbackFailures.map((result) => (result as PromiseRejectedResult).reason)],
        'runtime initialization and rollback failed',
      );
    }
    throw err;
  }
  // Load plugins from ~/.wigolo/plugins/
  try {
    const pluginResult = await loadPlugins();
    for (const ext of pluginResult.extractors) {
      pluginRegistry.registerExtractor(ext, ext.name);
      registerExtractor(ext);
    }
    for (const eng of pluginResult.searchEngines) {
      pluginRegistry.registerSearchEngine(eng, eng.name);
      searchEngines.push(eng);
    }
    if (pluginResult.errors.length > 0) {
      log.warn('some plugins failed to load', {
        errors: pluginResult.errors.map(e => `${e.pluginName}: ${e.message}`),
      });
    }
    if (pluginResult.loaded.length > 0) {
      log.info('plugins loaded', {
        count: pluginResult.loaded.length,
        names: pluginResult.loaded.map(p => p.name),
      });
    }
  } catch (err) {
    log.error('plugin loading failed', { error: String(err) });
  }

  let searxngProcess: SearxngProcess | null = null;
  let dockerSearxng: DockerSearxng | null = null;
  let searxngBootstrap: Promise<void> | null = null;

  async function bootstrapSearxng(): Promise<void> {
    // D1: the search-engine sidecar is opt-in. On the default core backend with
    // no external URL we do ZERO sidecar activity — no backend resolution (which
    // both probes runtimes and writes state files), no port probe, no process.
    if (!searxngConfigured(config)) {
      return;
    }

    // Configured (searxng/hybrid backend or external URL) but resolution never
    // installs implicitly. When no usable endpoint exists yet, tell the user how
    // to opt into the install rather than downloading behind their back.
    if (!searxngBackendAvailable(config)) {
      backendStatus.markUnhealthy(
        'search engine sidecar not installed — set WIGOLO_SEARXNG_URL to point at an ' +
        'external instance, or run `wigolo warmup --searxng` to install it',
      );
      log.warn(
        'search engine sidecar configured but not installed; using fallback engines. ' +
        'Set WIGOLO_SEARXNG_URL or run `wigolo warmup --searxng`',
      );
      return;
    }

    try {
      const initialState = getBootstrapState(config.dataDir);
      if (!config.searxngUrl && initialState?.status !== 'ready') {
        backendStatus.markBootstrapping();
      }

      const backend = await resolveSearchBackend();

      if (backend.type === 'external' && backend.url) {
        searchEngines.unshift(new SearxngClient(backend.url));
        backendStatus.markHealthy();
        log.info('using external search engine', { url: backend.url });
        return;
      }

      if (backend.type === 'native' && backend.searxngPath) {
        // We only reach here when the sidecar is already installed
        // (searxngBackendAvailable gated this). The installer is never invoked
        // implicitly — it lives behind `wigolo warmup --searxng`.
        const postBootstrapState = getBootstrapState(config.dataDir);
        if (postBootstrapState?.status === 'ready') {
          searxngProcess = new SearxngProcess(backend.searxngPath, config.dataDir, {
            onUnhealthy: (reason) => {
              backendStatus.markUnhealthy(reason);
              const idx = searchEngines.findIndex(e => e.name === 'searxng');
              if (idx >= 0) searchEngines.splice(idx, 1);
              log.warn('search engine marked unhealthy', { reason });
            },
            onHealthy: () => {
              const url = searxngProcess?.getUrl();
              if (!url) return;
              backendStatus.markHealthy();
              if (!searchEngines.some(e => e.name === 'searxng')) {
                searchEngines.unshift(new SearxngClient(url));
              }
              log.info('search engine recovered');
            },
          });
          const url = await searxngProcess.start();
          if (url) {
            searchEngines.unshift(new SearxngClient(url));
            backendStatus.markHealthy();
            log.info('search engine ready', { url });
          } else {
            log.warn('search engine failed to start, using fallback scraping');
            backendStatus.markUnhealthy('search engine process failed to start');
          }
        }
        return;
      }

      if (backend.type === 'docker') {
        dockerSearxng = new DockerSearxng();
        const url = await dockerSearxng.start();
        if (url) {
          searchEngines.unshift(new SearxngClient(url));
          backendStatus.markHealthy();
          log.info('search engine (docker) ready', { url });
        } else {
          log.warn('search engine (docker) failed to start, using fallback scraping');
          backendStatus.markUnhealthy('search engine (docker) failed to start');
        }
      }

      if (backend.type === 'scraping') {
        const state = getBootstrapState(config.dataDir);
        const reason = state?.lastError?.message ?? state?.error ?? 'no search engine backend available';
        backendStatus.markUnhealthy(reason);
      }
    } catch (err) {
      log.warn('background backend setup failed', { error: String(err) });
      backendStatus.markUnhealthy(`backend setup failed: ${String(err)}`);
    }
  }

  async function shutdown(): Promise<void> {
    log.info('Shutting down');
    if (searxngBootstrap) {
      await Promise.race([
        searxngBootstrap.catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
    }
    const results = await Promise.allSettled([
      searxngProcess?.stop(),
      dockerSearxng?.stop(),
      browserPool.shutdown(),
      closeDaemonBrowser(),
      Promise.resolve().then(() => resetEmbeddingService()),
      Promise.resolve().then(() => closeDatabase()),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => (result as PromiseRejectedResult).reason),
        'one or more runtime shutdown steps failed',
      );
    }
  }

  return {
    searchEngines,
    browserPool,
    router,
    backendStatus,
    pluginRegistry,
    shutdown,
    bootstrapSearxng: () => {
      searxngBootstrap = bootstrapSearxng();
      return searxngBootstrap;
    },
  };
}

export function createMcpServer(subsystems: Subsystems): Server {
  return createControlPlaneServer(subsystems).server;
}

export async function dispatchTool(
  subsystems: Subsystems,
  server: Server,
  request: CallToolRequest,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<CallToolResult> {
    const { searchEngines, router, backendStatus } = subsystems;
    const { name, arguments: args } = request.params;

    // Lazy-execution hook for the `watch` tool. Every non-watch tool call
    // gives us a chance to run overdue watch jobs in the background. This
    // is intentional: wigolo has no daemon — checks only fire when the
    // server is doing other work. `scheduleOverdueCheck` defers via
    // setImmediate and swallows errors, so it never blocks or fails the
    // primary tool call.
    if (name !== 'watch') {
      scheduleOverdueCheck(router);
    }

    // If the client supplied a progressToken in request._meta, build a
    // callback that forwards progress updates as notifications/progress.
    // Used by stream_answer to emit pipeline-phase progress.
    const meta = (request.params as { _meta?: { progressToken?: string | number } })._meta;
    const progressToken = meta?.progressToken;
    const onProgress: ProgressCallback | undefined =
      progressToken !== undefined && extra && typeof extra.sendNotification === 'function'
        ? async (update) => {
            try {
              await extra.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: update.progress,
                  total: update.total,
                  message: update.message,
                },
              } as Parameters<typeof extra.sendNotification>[0]);
            } catch (err) {
              log.debug('sendNotification failed', { error: String(err) });
            }
          }
        : undefined;

    if (name === 'fetch') {
      const input = (args ?? {}) as unknown as FetchInput;
      const r = await handleFetch(input, router);
      if (!r.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: r.error, error_reason: r.error_reason, stage: r.stage, ...(r.hint ? { hint: r.hint } : {}) }, null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }],
        isError: false,
      };
    }

    if (name === 'search') {
      const input = (args ?? {}) as unknown as SearchInput;
      const samplingServer = server as unknown as SamplingCapableServer;
      const r = await handleSearch(input, searchEngines, router, backendStatus, samplingServer, onProgress);
      if (!r.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: r.error, error_reason: r.error_reason, stage: r.stage, ...(r.hint ? { hint: r.hint } : {}) }, null, 2) }],
          isError: true,
        };
      }
      const blocks = buildSearchContentBlocks(input, r.data);
      return {
        content: blocks,
        isError: !!r.data.error,
      };
    }

    if (name === 'crawl') {
      const input = (args ?? {}) as unknown as CrawlInput;
      const result = await handleCrawl(input, router);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    }

    if (name === 'cache') {
      const input = (args ?? {}) as unknown as CacheInput;
      const result = await handleCache(input, router);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    }

    if (name === 'extract') {
      const input = (args ?? {}) as unknown as ExtractInput;
      const r = await handleExtract(input, router);
      if (!r.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: r.error, error_reason: r.error_reason, stage: r.stage, ...(r.hint ? { hint: r.hint } : {}) }, null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }],
        isError: false,
      };
    }

    if (name === 'find_similar') {
      const input = (args ?? {}) as unknown as FindSimilarInput;
      const r = await handleFindSimilar(input, searchEngines, router, backendStatus);
      if (!r.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: r.error, error_reason: r.error_reason, stage: r.stage, ...(r.hint ? { hint: r.hint } : {}) }, null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }],
        isError: false,
      };
    }

    if (name === 'research') {
      const input = (args ?? {}) as unknown as ResearchInput;
      const samplingServer = server as unknown as SamplingCapableServer;
      const r = await handleResearch(input, searchEngines, router, backendStatus, samplingServer);
      if (!r.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: r.error, error_reason: r.error_reason, stage: r.stage, ...(r.hint ? { hint: r.hint } : {}) }, null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }],
        isError: false,
      };
    }

    if (name === 'agent') {
      const input = (args ?? {}) as unknown as AgentInput;
      const samplingServer = server as unknown as SamplingCapableServer;
      const r = await handleAgent(input, searchEngines, router, backendStatus, samplingServer);
      if (!r.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: r.error, error_reason: r.error_reason, stage: r.stage, ...(r.hint ? { hint: r.hint } : {}) }, null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }],
        isError: false,
      };
    }

    // `diff` compares cached/inline content and needs no router; `watch`
    // takes the router because it fetches and diffs on each check.
    if (name === 'diff') {
      const input = (args ?? {}) as Record<string, unknown>;
      const r = await handleDiff(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(r.ok ? r.data : { error: r.error, error_reason: r.error_reason, stage: r.stage }, null, 2) }],
        isError: !r.ok,
      };
    }

    if (name === 'watch') {
      const input = (args ?? {}) as unknown as WatchJobInput;
      const r = await handleWatch(input, router);
      return {
        content: [{ type: 'text', text: JSON.stringify(r.ok ? r.data : { error: r.error, error_reason: r.error_reason, stage: r.stage, ...((r as { hint?: string }).hint ? { hint: (r as { hint?: string }).hint } : {}) }, null, 2) }],
        isError: !r.ok,
      };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

export function startRuntimeBackgroundWork(subs: Subsystems): void {
  maybeEagerWarmup();
  warmEngines();
  subs.bootstrapSearxng().catch((err) => {
    log.warn('search engine bootstrap failed', { error: String(err) });
  });
}
