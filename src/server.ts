import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SmartRouter, type HttpClient } from './fetch/router.js';
import { MultiBrowserPool } from './fetch/browser-pool.js';
import { closeDaemonBrowser } from './fetch/playwright-tier.js';
import { httpFetch } from './fetch/http-client.js';
import { initDatabase, closeDatabase, getDatabase } from './cache/db.js';
import { handleFetch } from './tools/fetch.js';
import { handleSearch } from './tools/search.js';
import { buildSearchContentBlocks } from './server/search-response.js';
import { fenceFetchData, fenceCrawlData, fenceExtractData, fenceFindSimilarData } from './server/content-fence.js';
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
import { resolveSearchBackend, bootstrapNativeSearxng, getBootstrapState } from './searxng/bootstrap.js';
import { SearxngProcess } from './searxng/process.js';
import { DockerSearxng } from './searxng/docker.js';
import { BackendStatus } from './server/backend-status.js';
import { maybeEagerWarmup } from './server/warmup-on-start.js';
import { getEmbeddingService, resetEmbeddingService } from './embedding/embed.js';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import {
  WIGOLO_INSTRUCTIONS,
  WIGOLO_INSTRUCTIONS_FULL,
  WIGOLO_DOCS_URI,
  TOOL_DESCRIPTIONS,
} from './instructions.js';
import {
  FETCH_TOOL_SCHEMA,
  SEARCH_TOOL_SCHEMA,
  CRAWL_TOOL_SCHEMA,
  CACHE_TOOL_SCHEMA,
  EXTRACT_TOOL_SCHEMA,
  FIND_SIMILAR_TOOL_SCHEMA,
  RESEARCH_TOOL_SCHEMA,
  AGENT_TOOL_SCHEMA,
  DIFF_TOOL_SCHEMA,
  WATCH_TOOL_SCHEMA,
  STUDIO_OBSERVE_TOOL_SCHEMA,
  STUDIO_ACT_TOOL_SCHEMA,
  STUDIO_MARKS_TOOL_SCHEMA,
  STUDIO_CAPTURE_TOOL_SCHEMA,
  STUDIO_SPAWN_TOOL_SCHEMA,
  STUDIO_CLOSE_TOOL_SCHEMA,
  STUDIO_LIST_TOOL_SCHEMA,
} from './server/tool-schemas.js';
import { loadPlugins } from './plugins/loader.js';
import { PluginRegistry } from './plugins/registry.js';
// The studio_* seam: routes execute-on-host / proxy / refuse. Reaches the session ONLY
// through the proxy + the (host-injected) studioHost closure — no session-module import,
// so the stdio path stays untouched (grep invariant).
import { dispatchStudioTool, proxyToStudioHost, type StudioHostHandlers } from './daemon/studio-dispatch.js';
import type { StudioSessionsAccessor } from './studio/session-drive.js';
import { isSessionTargeted, runSessionFetch, runSessionExtract, runSessionCrawl } from './tools/session-target.js';
import { projectToolArgs, recordToolCall, type ToolAuditDb } from './server/tool-audit.js';
import { registerExtractor } from './extraction/pipeline.js';
import type { FetchInput, SearchInput, SearchEngine, CrawlInput, CacheInput, ExtractInput, FindSimilarInput, ResearchInput, AgentInput, ProgressCallback, WatchJobInput } from './types.js';

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

/** D10: best-effort pull of the typed `error_reason` from a failed tool result's JSON envelope. The
 * value is a typed reason string (e.g. 'invalid_url', 'no_studio_session'), not user content — safe to
 * audit. Returns undefined when the envelope is absent/unparseable or carries no reason. */
function extractErrorReason(result: { content: { type: 'text'; text: string }[] }): string | undefined {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') return undefined;
  try {
    const parsed = JSON.parse(text) as { error_reason?: unknown };
    return typeof parsed.error_reason === 'string' ? parsed.error_reason : undefined;
  } catch {
    return undefined;
  }
}

export interface Subsystems {
  searchEngines: SearchEngine[];
  browserPool: MultiBrowserPool;
  router: SmartRouter;
  backendStatus: BackendStatus;
  pluginRegistry: PluginRegistry;
  shutdown: () => Promise<void>;
  bootstrapSearxng: () => Promise<void>;
  /** Set ONLY in the live Studio host process (injected by cli/studio.ts via DaemonHttpServer.setStudioHost). Undefined on stdio → studio_* calls proxy to the host. */
  studioHost?: StudioHostHandlers;
  /** D19: Set ONLY in the live Studio host process (injected via DaemonHttpServer.setStudioSessions). Undefined on stdio → a session-targeted fetch/extract/crawl proxies to the host (never a silent ephemeral fallback). */
  studioSessions?: StudioSessionsAccessor;
  /** D10: the (injected) handle the non-studio tool-invocation audit writes through. Wired from
   * getDatabase() in initSubsystems; left undefined by test harnesses that don't exercise the audit
   * (recordToolCall no-ops on undefined). The leaf never reaches for the global DB itself. */
  toolAuditDb?: ToolAuditDb;
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

  const backendStatus = new BackendStatus();

  const searchEngines: SearchEngine[] = [
    new BingEngine(),
    new DuckDuckGoEngine(),
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
    await closeDaemonBrowser().catch((e) => log.debug('closeDaemonBrowser failed', { error: e instanceof Error ? e.message : String(e) }));
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
    // D10: the live cache DB is the audit sink. initDatabase ran above, so getDatabase() resolves.
    toolAuditDb: getDatabase(),
  };
}

export function createMcpServer(subsystems: Subsystems): Server {
  const { searchEngines, router, backendStatus } = subsystems;

  const server = new Server(
    { name: 'wigolo', version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: WIGOLO_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: WIGOLO_DOCS_URI,
        name: 'Wigolo usage guide',
        description: 'Routing tables, performance budgets, auth flows, and other detail trimmed from the per-session instructions.',
        mimeType: 'text/markdown',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== WIGOLO_DOCS_URI) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    return {
      contents: [
        {
          uri: WIGOLO_DOCS_URI,
          mimeType: 'text/markdown',
          text: WIGOLO_INSTRUCTIONS_FULL,
        },
      ],
    };
  });

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
      {
        name: 'diff',
        description: TOOL_DESCRIPTIONS.diff,
        inputSchema: DIFF_TOOL_SCHEMA,
      },
      {
        name: 'watch',
        description: TOOL_DESCRIPTIONS.watch,
        inputSchema: WATCH_TOOL_SCHEMA,
      },
      {
        name: 'studio_observe',
        description: TOOL_DESCRIPTIONS.studio_observe,
        inputSchema: STUDIO_OBSERVE_TOOL_SCHEMA,
      },
      {
        name: 'studio_act',
        description: TOOL_DESCRIPTIONS.studio_act,
        inputSchema: STUDIO_ACT_TOOL_SCHEMA,
      },
      {
        name: 'studio_marks',
        description: TOOL_DESCRIPTIONS.studio_marks,
        inputSchema: STUDIO_MARKS_TOOL_SCHEMA,
      },
      {
        name: 'studio_capture',
        description: TOOL_DESCRIPTIONS.studio_capture,
        inputSchema: STUDIO_CAPTURE_TOOL_SCHEMA,
      },
      {
        name: 'studio_spawn',
        description: TOOL_DESCRIPTIONS.studio_spawn,
        inputSchema: STUDIO_SPAWN_TOOL_SCHEMA,
      },
      {
        name: 'studio_close',
        description: TOOL_DESCRIPTIONS.studio_close,
        inputSchema: STUDIO_CLOSE_TOOL_SCHEMA,
      },
      {
        name: 'studio_list',
        description: TOOL_DESCRIPTIONS.studio_list,
        inputSchema: STUDIO_LIST_TOOL_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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

    // D10: the whole tool dispatch runs inside one inner function so a SINGLE post-dispatch wrap can
    // audit every (non-studio_*) call — compute the result first, record it after as a fail-safe.
    const dispatch = async (): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> => {
    if (name === 'fetch') {
      const input = (args ?? {}) as unknown as FetchInput;
      // D19: a session_id routes to the live Studio session (navigate-class: gated + SSRF-fenced + trusted-0
      // insert). On the host the accessor is set ⇒ drive locally; on stdio it is undefined ⇒ forward to the host
      // VERBATIM (mirror the studio_* proxy). An absent/closed session is an explicit error, never an ephemeral fetch.
      if (isSessionTargeted(input)) {
        if (subsystems.studioSessions) {
          const sr = await runSessionFetch(subsystems.studioSessions, input);
          if (!sr.ok) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: sr.error, error_reason: sr.error_reason, stage: sr.stage, ...(sr.hint ? { hint: sr.hint } : {}) }, null, 2) }], isError: true };
          }
          return { content: [{ type: 'text', text: JSON.stringify(fenceFetchData(sr.data), null, 2) }], isError: false };
        }
        const proxied = await proxyToStudioHost('fetch', (args ?? {}) as Record<string, unknown>, getConfig().dataDir);
        return { content: proxied.content, isError: proxied.isError };
      }
      const r = await handleFetch(input, router);
      if (!r.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: r.error, error_reason: r.error_reason, stage: r.stage, ...(r.hint ? { hint: r.hint } : {}) }, null, 2) }],
          isError: true,
        };
      }
      // D7/A: fence the agent-facing markdown body (page-derived untrusted data) at the MCP envelope.
      return {
        content: [{ type: 'text', text: JSON.stringify(fenceFetchData(r.data), null, 2) }],
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
      // D19: a session_id routes the crawl to the live Studio session (navigation gated + SSRF-fenced).
      if (isSessionTargeted(input)) {
        if (subsystems.studioSessions) {
          const sessionResult = await runSessionCrawl(subsystems.studioSessions, input);
          return { content: [{ type: 'text', text: JSON.stringify(fenceCrawlData(sessionResult), null, 2) }], isError: !!sessionResult.error };
        }
        const proxied = await proxyToStudioHost('crawl', (args ?? {}) as Record<string, unknown>, getConfig().dataDir);
        return { content: proxied.content, isError: proxied.isError };
      }
      const result = await handleCrawl(input, router);
      // D7/A: fence each agent-facing per-page markdown body at the MCP envelope.
      return {
        content: [{ type: 'text', text: JSON.stringify(fenceCrawlData(result), null, 2) }],
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
      // D19: a session_id reads the live Studio session's CURRENT page (the sole token-free read — no navigation).
      if (isSessionTargeted(input)) {
        if (subsystems.studioSessions) {
          const sr = await runSessionExtract(subsystems.studioSessions, input, router);
          if (!sr.ok) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: sr.error, error_reason: sr.error_reason, stage: sr.stage, ...(sr.hint ? { hint: sr.hint } : {}) }, null, 2) }], isError: true };
          }
          return { content: [{ type: 'text', text: JSON.stringify(fenceExtractData(sr.data), null, 2) }], isError: false };
        }
        const proxied = await proxyToStudioHost('extract', (args ?? {}) as Record<string, unknown>, getConfig().dataDir);
        return { content: proxied.content, isError: proxied.isError };
      }
      const r = await handleExtract(input, router);
      if (!r.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: r.error, error_reason: r.error_reason, stage: r.stage, ...(r.hint ? { hint: r.hint } : {}) }, null, 2) }],
          isError: true,
        };
      }
      // D7/A: fence the agent-facing flat-string extraction (structured shapes handled in D7/B).
      return {
        content: [{ type: 'text', text: JSON.stringify(fenceExtractData(r.data), null, 2) }],
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
      // D7/B: fence the agent-facing per-result content (title/markdown); operational fields (url/score) raw.
      return {
        content: [{ type: 'text', text: JSON.stringify(fenceFindSimilarData(r.data), null, 2) }],
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

    // Slice A1 stub — `diff` real engine lands in slice B1. Watch shipped in
    // B3 (this file), so it takes a router and does real work.
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

    if (name === 'studio_observe' || name === 'studio_act' || name === 'studio_marks' || name === 'studio_capture' || name === 'studio_spawn' || name === 'studio_close' || name === 'studio_list') {
      // Route through the shared seam: execute-on-host (studioHost set) or proxy/refuse on stdio.
      // studio_act's control-token gate runs inside the host handler — host-authoritative.
      const result = await dispatchStudioTool(name, (args ?? {}) as Record<string, unknown>, subsystems.studioHost, getConfig().dataDir);
      return { content: result.content, isError: result.isError };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
    };

    // D10: compute the tool result FIRST, then record it as a best-effort fail-safe side effect.
    // recordToolCall swallows DB errors, so an audit write can never corrupt or fail the result.
    // studio_* calls are EXCLUDED — they carry the richer per-session studio_audit.
    const auditStartedAt = Date.now();
    const result = await dispatch();
    if (!name.startsWith('studio_')) {
      recordToolCall(subsystems.toolAuditDb, {
        tool: name,
        argsMeta: projectToolArgs(name, (args ?? {}) as Record<string, unknown>),
        outcomeOk: !result.isError,
        errorReason: result.isError ? extractErrorReason(result) : undefined,
        ts: Date.now(),
        durationMs: Date.now() - auditStartedAt,
      });
    }
    return result;
  });

  return server;
}

export async function startServer(): Promise<void> {
  const subs = await initSubsystems();
  const server = createMcpServer(subs);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server started');

  maybeEagerWarmup();

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
