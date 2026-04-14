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
import { SearxngClient } from './search/searxng.js';
import { DuckDuckGoEngine } from './search/engines/duckduckgo.js';
import { BingEngine } from './search/engines/bing.js';
import { StartpageEngine } from './search/engines/startpage.js';
import { resolveSearchBackend, bootstrapNativeSearxng, getBootstrapState } from './searxng/bootstrap.js';
import { SearxngProcess } from './searxng/process.js';
import { DockerSearxng } from './searxng/docker.js';
import { BackendStatus } from './server/backend-status.js';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { WIGOLO_INSTRUCTIONS, TOOL_DESCRIPTIONS } from './instructions.js';
import { loadPlugins } from './plugins/loader.js';
import { PluginRegistry } from './plugins/registry.js';
import { registerExtractor } from './extraction/pipeline.js';
import type { FetchInput, SearchInput, SearchEngine, CrawlInput, CacheInput, ExtractInput } from './types.js';

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
      description: 'Maximum characters to return',
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
    query: { type: 'string', description: 'Search query' },
    max_results: { type: 'number', description: 'Max results to return (default 5, max 20)' },
    include_content: { type: 'boolean', description: 'Fetch full content for results (default true)' },
    content_max_chars: { type: 'number', description: 'Max chars per result content (default 30000)' },
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
      enum: ['full', 'context'],
      description: "Output format: 'full' returns structured results (default), 'context' returns a single token-budgeted string ready for LLM context injection",
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
      enum: ['selector', 'tables', 'metadata', 'schema'],
      description: 'Extraction mode: selector (CSS), tables (HTML tables), metadata (meta tags + JSON-LD), schema (extract fields matching a JSON Schema via heuristic matching)',
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

  const httpClient: HttpClient = {
    fetch: (url, options) => httpFetch(url, options),
  };
  const browserPool = new MultiBrowserPool({
    browserTypes: config.browserTypes,
    selectionStrategy: 'round-robin',
  });
  const router = new SmartRouter(httpClient, browserPool);

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
      const backend = await resolveSearchBackend();

      if (backend.type === 'external' && backend.url) {
        searchEngines.unshift(new SearxngClient(backend.url));
        backendStatus.markHealthy();
        log.info('using external SearXNG', { url: backend.url });
        return;
      }

      if (backend.type === 'native' && backend.searxngPath) {
        const state = getBootstrapState(config.dataDir);
        if (state?.status !== 'ready') {
          log.info('SearXNG not ready — bootstrapping in background; search uses direct engines until ready');
          try {
            await bootstrapNativeSearxng(config.dataDir);
          } catch (err) {
            log.warn('SearXNG bootstrap failed, continuing with direct scraping fallback');
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
              log.warn('SearXNG marked unhealthy', { reason });
            },
            onHealthy: () => {
              const url = searxngProcess?.getUrl();
              if (!url) return;
              backendStatus.markHealthy();
              if (!searchEngines.some(e => e.name === 'searxng')) {
                searchEngines.unshift(new SearxngClient(url));
              }
              log.info('SearXNG recovered');
            },
          });
          const url = await searxngProcess.start();
          if (url) {
            searchEngines.unshift(new SearxngClient(url));
            backendStatus.markHealthy();
            log.info('SearXNG ready and added to search engines', { url });
          } else {
            log.warn('SearXNG failed to start, using direct scraping fallback');
            backendStatus.markUnhealthy('SearXNG process failed to start');
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
          log.info('Docker SearXNG ready', { url });
        } else {
          log.warn('Docker SearXNG failed to start, using direct scraping fallback');
          backendStatus.markUnhealthy('Docker SearXNG failed to start');
        }
      }

      if (backend.type === 'scraping') {
        const state = getBootstrapState(config.dataDir);
        const reason = state?.lastError?.message ?? state?.error ?? 'no SearXNG backend available';
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

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
      const result = await handleSearch(input, searchEngines, router, backendStatus);
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
    log.warn('SearXNG bootstrap failed', { error: String(err) });
  });

  const shutdown = async () => {
    await subs.shutdown();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
