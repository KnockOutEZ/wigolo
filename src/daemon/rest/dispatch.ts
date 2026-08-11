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
import { untrustedFenceParts } from '../../security/untrusted.js';
import {
  fenceFetchData,
  fenceSearchData,
  fenceCrawlData,
  fenceCacheData,
  fenceExtractData,
  fenceFindSimilarData,
  fenceResearchData,
  fenceAgentData,
  fenceDiffData,
  diffOriginFromInput,
} from '../../server/content-fence.js';
import type { UntrustedMode } from './untrusted-mode.js';
import type {
  AgentOutput,
  CacheOutput,
  CrawlOutput,
  DiffOutput,
  ExtractOutput,
  FetchOutput,
  FindSimilarOutput,
  MapOutput,
  ResearchOutput,
  SearchOutput,
} from '../../types.js';

export interface DispatchContext {
  subsystems: Subsystems;
  bindIsLoopback: boolean;
  /**
   * Where this response carries the trust boundary. Resolved per request from the
   * `X-Wigolo-Untrusted-Content` header in the router; `inline` is the native-route default (R2 / A10).
   */
  untrustedMode: UntrustedMode;
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
 * Tools whose 200 body carries page-derived text. `watch` is excluded: it returns
 * content hashes and coarse line counts, not page prose.
 *
 * EXPORTED so the tests can iterate the real set rather than a hand-copied literal. Adding a tool
 * here without adding its arm to `fenceRestBody` would fall through to `default` and ship the body
 * UNFENCED — a fail-open a duplicated list would have hidden.
 */
export const PAGE_DERIVED_TOOLS = new Set([
  'fetch', 'search', 'crawl', 'cache', 'extract', 'find_similar', 'research', 'agent', 'diff',
]);

/**
 * ── THE REST RESPONSE-SHAPING SEAM ──────────────────────────────────────────────────────────────
 *
 * CEO ruling R2 / decision A10 — the FENCED STRING is the DEFAULT REST representation; the structured
 * `untrusted_content` envelope is an explicit opt-in (`X-Wigolo-Untrusted-Content: envelope`).
 *
 * This AMENDS A3b/A9, which had it the other way round. A3b's reasoning was not refuted — fences must
 * never be persisted, and programmatic REST consumers (dedup pipelines, embedding indexers) really do
 * persist the markdown they read. It was OUTRANKED: those consumers can still get byte-clean payloads
 * by asking for the envelope, whereas the population A3b left exposed — a curl user, a shell script, or
 * a third-party framework concatenating `markdown` straight into a model's context — had no way to ask
 * for safety at all. F7 established that no SDK helper assembled the envelope; an envelope with no
 * consumer is not a control. The missing helper was never the bug. The DEFAULT was.
 *
 * The no-persist rule is preserved BY PLACEMENT, not by hope. Every content persist site in the tree is
 * strictly UPSTREAM of the value this function shapes: `cacheContent`/`embedAsync` fire inside
 * `handleFetch` before it builds its response, the crawl index queue reads the crawler's own item, and
 * watch hashes `handleFetch`'s output directly rather than a dispatched body. `dispatchTool` has exactly
 * one caller (router.ts) and its return value goes straight to the socket. Nothing in-tree reads a REST
 * RESPONSE back into a store. Two corollaries that must hold for that to stay true:
 *   - do NOT push this fence down into a tool handler. `watch/scheduler.ts` falls back to
 *     `sha256(fetched.data.markdown)` for `last_content_hash`; fencing inside `handleFetch` would hash
 *     marker bytes into `watch_jobs` and permanently break change detection for that job.
 *   - the fencers must stay COPY-ON-WRITE (content-fence.ts spreads at every level). In-place mutation
 *     here would reach arrays that upstream producers still hold references to.
 *
 * B3, now CLOSED. Research `citations[].snippet` regressed fenced → raw over REST when F1 moved all
 * containment to the response seam and this dispatcher returned handler output verbatim. A9 accepted
 * that under A3b; the default flip restores it, because `fenceResearchData` fences citation snippets.
 *
 * `src/daemon/rest/firecrawl-compat.ts` carries the INVERSE default (decision A11) — it never routes
 * through this dispatcher, and the loud rationale lives in that file.
 */
function withUntrustedEnvelope(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), untrusted_content: untrustedFenceParts() };
}

/**
 * Fence a successful page-derived body IN PLACE OF the envelope, using the same helpers the MCP
 * dispatch uses — so a REST consumer and an MCP consumer receive byte-identical containment modulo the
 * per-call nonce. There is no second implementation of the fence to drift.
 *
 * The switch is exhaustive over `PAGE_DERIVED_TOOLS` and nothing else; `watch` and any unknown tool
 * fall through unchanged. Rule 1 of content-fence.ts applies unchanged here: the decision is by TOOL
 * NAME, never by inspecting the value — a page-derived string is fenced whatever it contains.
 */
function fenceRestBody(tool: string, input: unknown, body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  switch (tool) {
    case 'fetch':
      return fenceFetchData(body as FetchOutput);
    case 'search':
      return fenceSearchData(body as SearchOutput);
    case 'crawl':
      return fenceCrawlData(body as CrawlOutput | (MapOutput & { crawled: number }));
    case 'cache':
      return fenceCacheData(body as CacheOutput);
    case 'extract':
      return fenceExtractData(body as ExtractOutput);
    case 'find_similar':
      return fenceFindSimilarData(body as FindSimilarOutput);
    case 'research':
      return fenceResearchData(body as ResearchOutput);
    case 'agent':
      return fenceAgentData(body as AgentOutput);
    case 'diff':
      return fenceDiffData(
        body as DiffOutput,
        diffOriginFromInput((input ?? {}) as Record<string, unknown>),
      );
    default:
      return body;
  }
}

function shapeUntrusted(tool: string, input: unknown, body: unknown, mode: UntrustedMode): unknown {
  if (!PAGE_DERIVED_TOOLS.has(tool)) return body;
  return mode === 'envelope' ? withUntrustedEnvelope(body) : fenceRestBody(tool, input, body);
}

/**
 * Per-tool dispatch behind the full router check pipeline. Every tool returns
 * plain JSON tool output on success; StageResult failures + crawl/cache in-band
 * errors + search data.error map through errors.ts. Successful page-derived
 * responses are then shaped for the request's untrusted-content representation:
 * fenced inline by default, or byte-clean with an `untrusted_content` envelope on opt-in.
 */
export async function dispatchTool(tool: string, input: unknown, ctx: DispatchContext): Promise<DispatchResult> {
  const result = await dispatchToolInner(tool, input, ctx);
  if (result.status !== 200) return result;
  return { ...result, body: shapeUntrusted(tool, input, result.body, ctx.untrustedMode) };
}

async function dispatchToolInner(tool: string, input: unknown, ctx: DispatchContext): Promise<DispatchResult> {
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
