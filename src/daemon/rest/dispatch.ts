import type { Subsystems } from '../../server.js';
import type { SamplingCapableServer } from '../../search/sampling.js';
import type {
  FetchInput,
  SearchInput,
  CrawlInput,
  CacheInput,
  ExtractInput,
  FindSimilarInput,
  ResearchInput,
  AgentInput,
  WatchJobInput,
} from '../../types.js';
import { handleFetch } from '../../tools/fetch.js';
import { handleSearch } from '../../tools/search.js';
import { handleCrawl } from '../../tools/crawl.js';
import { handleCache } from '../../tools/cache.js';
import { handleExtract } from '../../tools/extract.js';
import { handleFindSimilar } from '../../tools/find-similar.js';
import { handleResearch } from '../../tools/research.js';
import { handleAgent } from '../../tools/agent.js';
import { handleDiff, type DiffInput } from '../../tools/diff.js';
import { handleWatch } from '../../tools/watch.js';
import { scheduleOverdueCheck } from '../../watch/scheduler.js';
import { guardServeTarget } from './target-guard.js';
import { guardResolvedServeTarget, type SsrfResult, type SsrfRejection } from '../../watch/ssrf.js';
import { getConfig } from '../../config.js';
import {
  errorEnvelope,
  notImplemented,
  statusForStageResult,
  statusForSearchData,
  statusForCrawlCacheError,
} from './errors.js';

export interface DispatchContext {
  subsystems: Subsystems;
  bindIsLoopback: boolean;
}

export interface DispatchResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Envelope a StageResult failure. */
function stageFailure(f: { error: string; error_reason: string; stage: string; hint?: string }): DispatchResult {
  return {
    status: statusForStageResult(f),
    body: errorEnvelope(f.error_reason, f.error, { stage: f.stage, hint: f.hint }),
  };
}

/** 400 envelope from a serve-mode target-guard refusal (SSRF). */
function guardFailure(guard: Extract<SsrfResult, { ok: false }> | SsrfRejection): DispatchResult {
  return {
    status: 400,
    body: errorEnvelope(guard.code, guard.reason, { stage: 'validate', hint: guard.hint }),
  };
}

/**
 * Fetch-time SSRF re-check for a URL that already passed the serve-mode
 * literal guard. `guardServeTarget` (and the plain fetch guard it wraps) only
 * validates the LITERAL host, so a public hostname whose DNS record points at
 * a blocked address (cloud metadata / RFC-1918 / loopback under a
 * non-loopback bind) passes it and is only caught here, before we connect.
 * Returns null when allowed (or skipped for an IP literal — already
 * validated), a 400 DispatchResult when the resolved address is blocked.
 * Threads the SAME `allowPrivate` `guardServeTarget` used (config's
 * `fetchAllowPrivate` — `guardServeTarget` has no override param) so the
 * resolved-IP policy never drifts from the literal-IP one.
 */
async function resolvedGuardFailure(url: URL, ctx: DispatchContext): Promise<DispatchResult | null> {
  const host = url.hostname;
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isIpLiteral) return null;
  const resolved = await guardResolvedServeTarget(host, 'url', {
    allowPrivate: getConfig().fetchAllowPrivate,
    bindIsLoopback: ctx.bindIsLoopback,
  });
  if (!resolved.ok) return guardFailure(resolved);
  return null;
}

/**
 * Run the serve-mode target guard (literal + fetch-time resolved) on a
 * required URL. Returns null when allowed; a 400 DispatchResult when refused.
 * Mirrors the fetch dispatch pattern.
 */
async function guardUrlField(raw: unknown, ctx: DispatchContext): Promise<DispatchResult | null> {
  const guard = guardServeTarget(String(raw ?? ''), { bindIsLoopback: ctx.bindIsLoopback });
  if (!guard.ok) return guardFailure(guard);
  return resolvedGuardFailure(guard.url, ctx);
}

/**
 * Envelope a crawl/cache in-band `error` string. The value is either a stable
 * ssrf reason code (→ 400) or an upstream fetch code (→ 502); free text → 500.
 */
function crawlCacheFailure(errorKey: string): DispatchResult {
  return {
    status: statusForCrawlCacheError(errorKey),
    body: errorEnvelope(errorKey, errorKey, { stage: 'crawl' }),
  };
}

async function dispatchFetch(input: FetchInput, ctx: DispatchContext): Promise<DispatchResult> {
  const guard = guardServeTarget(String((input as { url?: unknown }).url ?? ''), {
    bindIsLoopback: ctx.bindIsLoopback,
  });
  if (!guard.ok) {
    return { status: 400, body: errorEnvelope(guard.code, guard.reason, { stage: 'validate', hint: guard.hint }) };
  }
  const resolvedFail = await resolvedGuardFailure(guard.url, ctx);
  if (resolvedFail) return resolvedFail;
  const r = await handleFetch(input, ctx.subsystems.router);
  if (!r.ok) return stageFailure(r);
  return { status: 200, body: r.data };
}

async function dispatchSearch(input: SearchInput, ctx: DispatchContext): Promise<DispatchResult> {
  const { searchEngines, router, backendStatus } = ctx.subsystems;
  // Serve mode carries no LLM sampling client; format:'answer' degrades to the
  // keyless ladder inside the handler.
  const r = await handleSearch(input, searchEngines, router, backendStatus, undefined as unknown as SamplingCapableServer);
  if (!r.ok) return stageFailure(r);
  const remap = statusForSearchData(r.data as { error?: unknown; warning?: unknown });
  if (remap !== null) {
    const data = r.data as { error?: string };
    return {
      status: remap,
      body: errorEnvelope('search_failed', typeof data.error === 'string' ? data.error : 'search failed', {
        stage: 'search',
      }),
    };
  }
  return { status: 200, body: r.data };
}

async function dispatchCrawl(input: CrawlInput, ctx: DispatchContext): Promise<DispatchResult> {
  const refused = await guardUrlField(input.url, ctx);
  if (refused) return refused;
  const result = await handleCrawl(input, ctx.subsystems.router);
  if (typeof result.error === 'string' && result.error.length > 0) {
    return crawlCacheFailure(result.error);
  }
  return { status: 200, body: result };
}

async function dispatchCache(input: CacheInput, ctx: DispatchContext): Promise<DispatchResult> {
  const result = await handleCache(input, ctx.subsystems.router);
  if (typeof result.error === 'string' && result.error.length > 0) {
    return crawlCacheFailure(result.error);
  }
  return { status: 200, body: result };
}

async function dispatchExtract(input: ExtractInput, ctx: DispatchContext): Promise<DispatchResult> {
  if (input.url !== undefined && input.url !== '') {
    const refused = await guardUrlField(input.url, ctx);
    if (refused) return refused;
  }
  const r = await handleExtract(input, ctx.subsystems.router);
  if (!r.ok) return stageFailure(r);
  return { status: 200, body: r.data };
}

async function dispatchFindSimilar(input: FindSimilarInput, ctx: DispatchContext): Promise<DispatchResult> {
  if (input.url !== undefined && input.url !== '') {
    const refused = await guardUrlField(input.url, ctx);
    if (refused) return refused;
  }
  const { searchEngines, router, backendStatus } = ctx.subsystems;
  const r = await handleFindSimilar(input, searchEngines, router, backendStatus);
  if (!r.ok) return stageFailure(r);
  return { status: 200, body: r.data };
}

async function dispatchResearch(input: ResearchInput, ctx: DispatchContext): Promise<DispatchResult> {
  const { searchEngines, router, backendStatus } = ctx.subsystems;
  // Serve mode carries no LLM sampling client; synthesis degrades to the
  // keyless ladder inside the handler.
  const r = await handleResearch(input, searchEngines, router, backendStatus, undefined);
  if (!r.ok) return stageFailure(r);
  return { status: 200, body: r.data };
}

async function dispatchAgent(input: AgentInput, ctx: DispatchContext): Promise<DispatchResult> {
  for (const u of input.urls ?? []) {
    const refused = await guardUrlField(u, ctx);
    if (refused) return refused;
  }
  const { searchEngines, router, backendStatus } = ctx.subsystems;
  const r = await handleAgent(input, searchEngines, router, backendStatus, undefined);
  if (!r.ok) return stageFailure(r);
  return { status: 200, body: r.data };
}

async function dispatchDiff(input: DiffInput, _ctx: DispatchContext): Promise<DispatchResult> {
  const r = await handleDiff(input);
  if (!r.ok) return stageFailure(r);
  return { status: 200, body: r.data };
}

async function dispatchWatch(input: WatchJobInput, ctx: DispatchContext): Promise<DispatchResult> {
  if (input.url !== undefined && input.url !== '') {
    const refused = await guardUrlField(input.url, ctx);
    if (refused) return refused;
  }
  for (const u of input.urls ?? []) {
    const refused = await guardUrlField(u, ctx);
    if (refused) return refused;
  }
  const r = await handleWatch(input, ctx.subsystems.router);
  if (!r.ok) return stageFailure(r);
  return { status: 200, body: r.data };
}

/**
 * Per-tool dispatch behind the full router check pipeline. Every tool returns
 * plain JSON tool output on success; StageResult failures + crawl/cache in-band
 * errors + search data.error map through errors.ts.
 */
export async function dispatchTool(tool: string, input: unknown, ctx: DispatchContext): Promise<DispatchResult> {
  // Lazy watch-scheduler hook — same semantics as the MCP dispatch. Fires for
  // every non-watch call.
  if (tool !== 'watch') {
    scheduleOverdueCheck(ctx.subsystems.router);
  }

  const body = (input ?? {}) as Record<string, unknown>;

  switch (tool) {
    case 'fetch':
      return dispatchFetch(body as unknown as FetchInput, ctx);
    case 'search':
      return dispatchSearch(body as unknown as SearchInput, ctx);
    case 'crawl':
      return dispatchCrawl(body as unknown as CrawlInput, ctx);
    case 'cache':
      return dispatchCache(body as unknown as CacheInput, ctx);
    case 'extract':
      return dispatchExtract(body as unknown as ExtractInput, ctx);
    case 'find_similar':
      return dispatchFindSimilar(body as unknown as FindSimilarInput, ctx);
    case 'research':
      return dispatchResearch(body as unknown as ResearchInput, ctx);
    case 'agent':
      return dispatchAgent(body as unknown as AgentInput, ctx);
    case 'diff':
      return dispatchDiff(body as unknown as DiffInput, ctx);
    case 'watch':
      return dispatchWatch(body as unknown as WatchJobInput, ctx);
    default:
      return { status: 501, body: notImplemented(tool).body };
  }
}
