import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SmartRouter, type HttpClient } from './fetch/router.js';
import { BrowserPool } from './fetch/browser-pool.js';
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
import { resolveSearchBackend } from './searxng/bootstrap.js';
import { SearxngProcess } from './searxng/process.js';
import { DockerSearxng } from './searxng/docker.js';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import type { FetchInput, SearchInput, SearchEngine, CrawlInput, CacheInput, ExtractInput } from './types.js';

const log = createLogger('server');

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
      enum: ['bfs', 'dfs', 'sitemap'],
      description: 'Crawl strategy (default: bfs)',
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
  },
};

const EXTRACT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: { type: 'string', description: 'URL to fetch and extract from' },
    html: { type: 'string', description: 'Raw HTML to extract from (url takes priority if both provided)' },
    mode: {
      type: 'string',
      enum: ['selector', 'tables', 'metadata'],
      description: 'Extraction mode (default: metadata)',
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
      description: 'JSON Schema for structured extraction (v2 — currently accepted but ignored)',
    },
  },
};

export async function startServer(): Promise<void> {
  const config = getConfig();

  mkdirSync(config.dataDir, { recursive: true });
  initDatabase(join(config.dataDir, 'wigolo.db'));

  const httpClient: HttpClient = {
    fetch: (url, options) => httpFetch(url, options),
  };
  const browserPool = new BrowserPool();
  const router = new SmartRouter(httpClient, browserPool);

  // --- Search backend initialization ---
  const backend = await resolveSearchBackend();
  const searchEngines: SearchEngine[] = [];
  let searxngProcess: SearxngProcess | null = null;
  let dockerSearxng: DockerSearxng | null = null;

  if (backend.type === 'external' && backend.url) {
    searchEngines.push(new SearxngClient(backend.url));
  } else if (backend.type === 'native' && backend.searxngPath) {
    searxngProcess = new SearxngProcess(backend.searxngPath, config.dataDir);
    const url = await searxngProcess.start();
    if (url) {
      searchEngines.push(new SearxngClient(url));
    } else {
      log.warn('SearXNG failed to start, using direct scraping fallback');
    }
  } else if (backend.type === 'docker') {
    dockerSearxng = new DockerSearxng();
    const url = await dockerSearxng.start();
    if (url) {
      searchEngines.push(new SearxngClient(url));
    } else {
      log.warn('Docker SearXNG failed to start, using direct scraping fallback');
    }
  }

  searchEngines.push(new BingEngine(), new DuckDuckGoEngine(), new StartpageEngine());

  const server = new Server(
    { name: 'wigolo', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'fetch',
        description:
          'Fetch a web page and return its content as clean markdown. ' +
          'Supports JavaScript rendering, auth, section extraction, and caching.',
        inputSchema: FETCH_TOOL_SCHEMA,
      },
      {
        name: 'search',
        description:
          'Search the web and return results with optional full content extraction. ' +
          'One call: query in, clean markdown out.',
        inputSchema: SEARCH_TOOL_SCHEMA,
      },
      {
        name: 'crawl',
        description:
          'Crawl a website starting from a seed URL. Supports BFS, DFS, and sitemap strategies ' +
          'with depth/page limits, URL filtering, and cross-page content deduplication.',
        inputSchema: CRAWL_TOOL_SCHEMA,
      },
      {
        name: 'cache',
        description:
          'Query the local knowledge base of previously fetched content. ' +
          'Search cached pages by full-text query, URL pattern, or date. ' +
          'Can also return cache statistics or clear entries.',
        inputSchema: CACHE_TOOL_SCHEMA,
      },
      {
        name: 'extract',
        description:
          'Extract structured data from a web page. Supports CSS selector extraction, ' +
          'table-to-JSON conversion, and metadata extraction (title, author, date, etc.).',
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
      const result = await handleSearch(input, searchEngines, router);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
      const result = handleCache(input);
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server started');

  const shutdown = async () => {
    log.info('Shutting down');
    if (searxngProcess) await searxngProcess.stop();
    if (dockerSearxng) await dockerSearxng.stop();
    await browserPool.shutdown();
    closeDatabase();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
