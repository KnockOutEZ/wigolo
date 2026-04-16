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

const FETCH_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: { type: 'string', description: 'URL to fetch' },
    render_js: {
      type: 'string',
      enum: ['auto', 'always', 'never'],
      description: 'JavaScript rendering mode (default: auto)',
    },
    use_auth: {
      type: 'boolean',
      description: 'Use stored auth credentials (default: false)',
    },
    max_chars: {
      type: 'number',
      description: 'Maximum characters to return (hard slice)',
    },
    max_content_chars: {
      type: 'number',
      description: 'Smart truncate markdown to N chars at paragraph/heading boundary with [... content truncated] marker. Preferred over max_chars for AI agents.',
    },
    section: {
      type: 'string',
      description: 'Extract a specific section by heading text',
    },
    section_index: {
      type: 'number',
      description: 'Index of the section match (default: 0)',
    },
    screenshot: {
      type: 'boolean',
      description: 'Capture a screenshot (default: false)',
    },
    headers: {
      type: 'object',
      description: 'Additional HTTP headers',
      additionalProperties: { type: 'string' },
    },
    force_refresh: {
      type: 'boolean',
      description: 'Bypass cache and fetch fresh content from the network. Use for rapidly changing pages (news, changelogs, dashboards).',
    },
    actions: {
      type: 'array',
      description:
        'Sequential browser actions to perform before extracting content. ' +
        'When present, forces Playwright rendering (bypasses HTTP-first routing).',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['click', 'type', 'wait', 'wait_for', 'scroll', 'screenshot'],
            description: 'Action type',
          },
          selector: {
            type: 'string',
            description: 'CSS selector (required for click, type, wait_for)',
          },
          text: {
            type: 'string',
            description: 'Text to type (required for type action)',
          },
          ms: {
            type: 'number',
            description: 'Milliseconds to wait (required for wait action)',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in ms for wait_for action (default: 5000)',
          },
          direction: {
            type: 'string',
            enum: ['down', 'up'],
            description: 'Scroll direction (required for scroll action)',
          },
          amount: {
            type: 'number',
            description: 'Scroll amount in pixels (default: viewport height)',
          },
        },
        required: ['type'],
      },
    },
  },
  required: ['url'],
};

const SEARCH_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: {
      oneOf: [
        { type: 'string', description: 'Search query' },
        {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of query variants to search in parallel, deduplicate, and rerank',
        },
      ],
      description: 'Search query — a single string or array of query variants for parallel multi-query search',
    },
    max_results: { type: 'number', description: 'Max results to return (default 5, max 20)' },
    include_content: { type: 'boolean', description: 'Fetch full content for results (default true)' },
    content_max_chars: { type: 'number', description: 'Max chars per result content at extraction (default 30000)' },
    max_content_chars: { type: 'number', description: 'Smart-truncate each result markdown at paragraph boundary with marker (e.g. 3000 for compact context)' },
    max_total_chars: { type: 'number', description: 'Max total chars across all results (default 50000)' },
    time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Time range filter' },
    search_engines: { type: 'array', items: { type: 'string' }, description: 'Override engine selection' },
    language: { type: 'string', description: 'Language preference' },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only return results from these domains (e.g. ["react.dev", "github.com"])',
    },
    exclude_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Never return results from these domains',
    },
    from_date: {
      type: 'string',
      description: 'ISO date (YYYY-MM-DD) — only return results published after this date',
    },
    to_date: {
      type: 'string',
      description: 'ISO date (YYYY-MM-DD) — only return results published before this date',
    },
    category: {
      type: 'string',
      enum: ['general', 'news', 'code', 'docs', 'papers', 'images'],
      description: 'Category of search (general, news, code, docs, papers, images)',
    },
    format: {
      type: 'string',
      enum: ['full', 'context', 'answer', 'highlights', 'stream_answer'],
      description:
        "Output format: 'full' returns structured results (default); 'context' returns a single token-budgeted string for LLM injection; 'highlights' returns ML-scored passages per source with citations (no LLM needed — the host agent synthesizes); 'answer' requests LLM synthesis via MCP sampling and falls back to 'highlights' when sampling is unsupported; 'stream_answer' same as 'answer' but emits progress notifications between pipeline phases (search/fetch/synthesize) when the client supplies a progressToken",
    },
    max_highlights: {
      type: 'number',
      description: "Maximum highlights to return when format is 'highlights' (default 10). Highlights are 1-3 sentence passages scored by relevance to the query.",
    },
    force_refresh: {
      type: 'boolean',
      description: 'Bypass all caches (search results and page content). Use when you need the most current information.',
    },
  },
  required: ['query'],
};

const CRAWL_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: { type: 'string', description: 'Seed URL to start crawling from' },
    max_depth: { type: 'number', description: 'Maximum link depth from seed (default: 2)' },
    max_pages: { type: 'number', description: 'Maximum pages to crawl (default: 20)' },
    strategy: {
      type: 'string',
      enum: ['bfs', 'dfs', 'sitemap', 'map'],
      description: 'Crawl strategy: bfs (breadth-first), dfs (depth-first), sitemap (use sitemap.xml), map (URL-only discovery — returns list of URLs without content, faster than full crawl)',
    },
    include_patterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'URL regex whitelist — only crawl matching URLs',
    },
    exclude_patterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'URL regex blacklist — skip matching URLs',
    },
    use_auth: { type: 'boolean', description: 'Use stored auth credentials (default: false)' },
    extract_links: { type: 'boolean', description: 'Return link graph between pages (default: false)' },
    max_total_chars: { type: 'number', description: 'Max total chars across all pages (default: 100000)' },
  },
  required: ['url'],
};

const CACHE_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: { type: 'string', description: 'Full-text search over cached content' },
    url_pattern: {
      type: 'string',
      description: 'Filter by URL glob pattern (e.g., "*example.com*")',
    },
    since: {
      type: 'string',
      description: 'ISO date — only results cached after this date',
    },
    clear: {
      type: 'boolean',
      description: 'Clear matching cache entries (requires at least one filter: query, url_pattern, or since)',
    },
    stats: {
      type: 'boolean',
      description: 'Return cache statistics (total URLs, size, date range)',
    },
    check_changes: {
      type: 'boolean',
      description:
        'Re-fetch all matching cached URLs and report which ones have changed. ' +
        'Returns a list of URLs with changed/unchanged status and diff summaries. ' +
        'Use with query or url_pattern to scope which cached entries to check.',
    },
  },
};

const EXTRACT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: { type: 'string', description: 'URL to fetch and extract from' },
    html: { type: 'string', description: 'Raw HTML to extract from (url takes priority if both provided)' },
    mode: {
      type: 'string',
      enum: ['selector', 'tables', 'metadata', 'schema', 'structured'],
      description: 'Extraction mode: selector (CSS), tables (HTML tables), metadata (meta tags + JSON-LD), schema (fields matching a JSON Schema), structured (tables + definition lists + JSON-LD + chart hints + key/value pairs — one-shot structured brief)',
    },
    css_selector: {
      type: 'string',
      description: 'CSS selector to match (required when mode="selector")',
    },
    multiple: {
      type: 'boolean',
      description: 'Return array of all matches instead of first (default: false, only for mode="selector")',
    },
    schema: {
      type: 'object',
      description: 'JSON Schema defining fields to extract. Field names are matched against page content via CSS classes, ARIA labels, microdata, and JSON-LD. Required when mode="schema".',
    },
  },
};

const FIND_SIMILAR_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: {
      type: 'string',
      description: 'Find pages similar to this URL. The page is fetched (or read from cache) and its content analyzed for key terms.',
    },
    concept: {
      type: 'string',
      description: 'Find pages related to this concept or topic description. Use when you don\'t have a specific URL.',
    },
    max_results: {
      type: 'number',
      description: 'Maximum results to return (default 10, max 50)',
    },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only return results from these domains',
    },
    exclude_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Never return results from these domains',
    },
    include_cache: {
      type: 'boolean',
      description: 'Search local cache for similar pages (default: true)',
    },
    include_web: {
      type: 'boolean',
      description: 'Supplement with web search if needed (default: true)',
    },
  },
};

const RESEARCH_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    question: { type: 'string', description: 'The research question to investigate' },
    depth: {
      type: 'string',
      enum: ['quick', 'standard', 'comprehensive'],
      description: 'Research depth: quick (~15s), standard (~40s, default), comprehensive (~80s)',
    },
    max_sources: {
      type: 'number',
      description: 'Override the default source count for the chosen depth (max 50)',
    },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only search results from these domains',
    },
    exclude_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exclude results from these domains',
    },
    schema: {
      type: 'object',
      description: 'Optional JSON Schema -- structure the report to extract these fields',
    },
    stream: {
      type: 'boolean',
      description: 'Send progress notifications as each research phase completes',
    },
  },
  required: ['question'],
};

const AGENT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    prompt: {
      type: 'string',
      description: 'Natural-language description of what data to gather',
    },
    urls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific URLs to include in the data gathering',
    },
    schema: {
      type: 'object',
      description: 'Optional JSON Schema -- extract structured data matching this schema from each page',
    },
    max_pages: {
      type: 'number',
      description: 'Maximum pages to fetch (default 10, max 100)',
    },
    max_time_ms: {
      type: 'number',
      description: 'Maximum execution time in milliseconds (default 60000)',
    },
    stream: {
      type: 'boolean',
      description: 'Send progress notifications as each step completes',
    },
  },
  required: ['prompt'],
};

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
