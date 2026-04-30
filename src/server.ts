import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SmartRouter, type HttpClient } from './fetch/router.js';
import { MultiBrowserPool } from './fetch/browser-pool.js';
import { httpFetch } from './fetch/http-client.js';
import { initDatabase, closeDatabase } from './cache/db.js';
import { handleFetch } from './tools/fetch.js';
import { handleSearch } from './tools/search.js';
import { handleCrawl } from './tools/crawl.js';
import { handleCache } from './tools/cache.js';
import { handleExtract } from './tools/extract.js';
import { handleFindSimilar } from './tools/find-similar.js';
import { handleResearch } from './tools/research.js';
import { handleAgent } from './tools/agent.js';
import type { SamplingCapableServer } from './search/sampling.js';
import { SearxngClient } from './search/searxng.js';
import { DuckDuckGoEngine } from './search/engines/duckduckgo.js';
import { BingEngine } from './search/engines/bing.js';
import { StartpageEngine } from './search/engines/startpage.js';
import { resolveSearchBackend, bootstrapNativeSearxng, getBootstrapState } from './searxng/bootstrap.js';
import { SearxngProcess } from './searxng/process.js';
import { DockerSearxng } from './searxng/docker.js';
import { BackendStatus } from './server/backend-status.js';
import { getEmbeddingService, resetEmbeddingService } from './embedding/embed.js';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { WIGOLO_INSTRUCTIONS, TOOL_DESCRIPTIONS } from './instructions.js';
import {
  FETCH_TOOL_SCHEMA,
  SEARCH_TOOL_SCHEMA,
  CRAWL_TOOL_SCHEMA,
  CACHE_TOOL_SCHEMA,
  EXTRACT_TOOL_SCHEMA,
  FIND_SIMILAR_TOOL_SCHEMA,
  RESEARCH_TOOL_SCHEMA,
  AGENT_TOOL_SCHEMA,
} from './server/tool-schemas.js';
import { loadPlugins } from './plugins/loader.js';
import { PluginRegistry } from './plugins/registry.js';
import { registerExtractor } from './extraction/pipeline.js';
import type { FetchInput, SearchInput, SearchEngine, CrawlInput, CacheInput, ExtractInput, FindSimilarInput, ResearchInput, AgentInput, ProgressCallback } from './types.js';

const log = createLogger('server');

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/server.ts in dev, dist/server.js in build — both are siblings of package.json
    const pkgPath = join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_VERSION = readPackageVersion();

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
  initDatabase(join(config.dataDir, 'wigolo.db'));

  // Initialize embedding service: loads stored vectors into in-memory index
  // so find_similar can run the embedding path. Subprocess starts lazily on
  // first embed() call, so this is cheap if no embeddings exist yet.
  try {
    await getEmbeddingService().init();
  } catch (err) {
    log.warn('embedding service init failed, find_similar will run without embedding path', {
      error: String(err),
    });
  }

  const httpClient: HttpClient = {
    fetch: (url, options) => httpFetch(url, options),
  };
  const browserPool = new MultiBrowserPool({
    browserTypes: config.browserTypes,
    selectionStrategy: 'round-robin',
  });
  const router = new SmartRouter(httpClient, browserPool);

  if (config.lightpandaEnabled && config.lightpandaUrl) {
    log.info('lightpanda browser backend enabled', {
      url: config.lightpandaUrl,
      failureThreshold: config.lightpandaFailureThreshold,
    });
  }

  const backendStatus = new BackendStatus();

  const searchEngines: SearchEngine[] = [
    new BingEngine(),
    new DuckDuckGoEngine(),
    new StartpageEngine(),
  ];
  // Load plugins from ~/.wigolo/plugins/
  const pluginRegistry = new PluginRegistry();
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
        const state = getBootstrapState(config.dataDir);
        if (state?.status !== 'ready') {
          log.info('search engine not ready — bootstrapping in background; search uses fallback engines until ready');
          try {
            await bootstrapNativeSearxng(config.dataDir);
          } catch (err) {
            log.warn('search engine bootstrap failed, continuing with fallback scraping');
            backendStatus.markUnhealthy(`bootstrap exception: ${String(err)}`);
            return;
          }
        }
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
    if (searxngProcess) await searxngProcess.stop();
    if (dockerSearxng) await dockerSearxng.stop();
    await browserPool.shutdown();
    resetEmbeddingService();
    closeDatabase();
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
  const { searchEngines, router, backendStatus } = subsystems;

  const server = new Server(
    { name: 'wigolo', version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: WIGOLO_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'fetch',
        description: TOOL_DESCRIPTIONS.fetch,
        inputSchema: FETCH_TOOL_SCHEMA,
      },
      {
        name: 'search',
        description: TOOL_DESCRIPTIONS.search,
        inputSchema: SEARCH_TOOL_SCHEMA,
      },
      {
        name: 'crawl',
        description: TOOL_DESCRIPTIONS.crawl,
        inputSchema: CRAWL_TOOL_SCHEMA,
      },
      {
        name: 'cache',
        description: TOOL_DESCRIPTIONS.cache,
        inputSchema: CACHE_TOOL_SCHEMA,
      },
      {
        name: 'extract',
        description: TOOL_DESCRIPTIONS.extract,
        inputSchema: EXTRACT_TOOL_SCHEMA,
      },
      {
        name: 'find_similar',
        description: TOOL_DESCRIPTIONS.find_similar,
        inputSchema: FIND_SIMILAR_TOOL_SCHEMA,
      },
      {
        name: 'research',
        description: TOOL_DESCRIPTIONS.research,
        inputSchema: RESEARCH_TOOL_SCHEMA,
      },
      {
        name: 'agent',
        description: TOOL_DESCRIPTIONS.agent,
        inputSchema: AGENT_TOOL_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

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
      const result = await handleFetch(input, router);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    }

    if (name === 'search') {
      const input = (args ?? {}) as unknown as SearchInput;
      const samplingServer = server as unknown as SamplingCapableServer;
      const result = await handleSearch(input, searchEngines, router, backendStatus, samplingServer, onProgress);
      const blocks: { type: 'text'; text: string }[] = [];
      if (result.warning) {
        blocks.push({ type: 'text', text: `[wigolo notice] ${result.warning}` });
      }
      blocks.push({ type: 'text', text: JSON.stringify(result, null, 2) });
      return {
        content: blocks,
        isError: !!result.error,
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
      const result = await handleExtract(input, router);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    }

    if (name === 'find_similar') {
      const input = (args ?? {}) as unknown as FindSimilarInput;
      const result = await handleFindSimilar(input, searchEngines, router, backendStatus);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    }

    if (name === 'research') {
      const input = (args ?? {}) as unknown as ResearchInput;
      const samplingServer = server as unknown as SamplingCapableServer;
      const result = await handleResearch(input, searchEngines, router, backendStatus, samplingServer);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    }

    if (name === 'agent') {
      const input = (args ?? {}) as unknown as AgentInput;
      const samplingServer = server as unknown as SamplingCapableServer;
      const result = await handleAgent(input, searchEngines, router, backendStatus, samplingServer);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

export async function startServer(): Promise<void> {
  const subs = await initSubsystems();
  const server = createMcpServer(subs);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server started');

  subs.bootstrapSearxng().catch((err) => {
    log.warn('search engine bootstrap failed', { error: String(err) });
  });

  const shutdown = async () => {
    await subs.shutdown();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
