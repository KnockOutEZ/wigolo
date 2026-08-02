import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Subsystems } from '../../server.js';
import type { SamplingCapableServer } from '../../search/sampling.js';
import type {
  CrawlInput,
  CrawlOutput,
  FetchInput,
  FetchOutput,
  MapOutput,
  SearchInput,
  SearchOutput,
} from '../../types.js';
import { handleFetch } from '../../tools/fetch.js';
import { handleSearch } from '../../tools/search.js';
import { handleCrawl } from '../../tools/crawl.js';
import { createLogger } from '../../logger.js';
import { readJsonBodyCapped, bodyCapFor, BodyTooLargeError, CLAMP_TABLE } from './limits.js';
import {
  statusForStageResult,
  statusForCrawlCacheError,
  type StageFailure,
} from './errors.js';
import { guardServeTarget } from './target-guard.js';
import { guardResolvedServeTarget } from '../../watch/ssrf.js';
import { getConfig } from '../../config.js';

/**
 * Firecrawl-compatibility shim (EXPERIMENTAL, flag `WIGOLO_FIRECRAWL_COMPAT=1`).
 * Maps a lite subset of the Firecrawl v1 surface onto wigolo's tool handlers so
 * a Firecrawl SDK pointed at `http://host:3333/compat/firecrawl` gets a
 * drop-in. Auth, resource limits, and the SSRF target guard all run BEFORE this
 * handler in the router pipeline (or are re-applied here for the URL guard);
 * the shim is NOT an escape hatch. Shapes verified against the public
 * Firecrawl API docs.
 *
 * Out of scope (documented, not silently missing): batch, screenshot /
 * changeTracking / html / rawHtml formats, v2 surface, webhooks, extract, agent.
 */

const log = createLogger('rest');

/** Formats the shim can honour. 'markdown' is produced from the fetch output;
 * anything else is ignored (documented — we return what we can, drop the rest). */
const SUPPORTED_FORMATS = new Set(['markdown']);

/** Firecrawl `limit` default + hard cap for search results. */
const SEARCH_LIMIT_DEFAULT = 5;
const SEARCH_LIMIT_MAX = 20;

/** Crawl `max_pages` clamp — single source of truth is the limits.ts table. */
const CRAWL_MAX_PAGES = CLAMP_TABLE.find((c) => c.tool === 'crawl' && c.field === 'max_pages')?.max ?? 200;

/** Job store: 100 completed/active jobs OR the byte cap, whichever hits first. */
const JOB_COUNT_CAP = 100;
const JOB_TTL_MS = 30 * 60 * 1000; // completed/failed jobs expire after 30 min

/** Concurrent RUNNING crawl-jobs cap. The job-store caps bound STORAGE only —
 * without this, rapid crawl POSTs would launch unbounded concurrent background
 * crawls (each up to the max_pages clamp). Over-cap POSTs are refused (429),
 * never queued. */
const RUNNING_JOBS_DEFAULT_CAP = 16;

function maxCompatJobs(): number {
  const override = process.env.WIGOLO_SERVE_MAX_COMPAT_JOBS;
  if (override) {
    const n = Number(override);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return RUNNING_JOBS_DEFAULT_CAP;
}

// Count of background crawls currently EXECUTING ('scraping'). Incremented at
// job launch, decremented when the crawl promise settles (success or failure).
// Tracked separately from the job store because store eviction could remove a
// still-running job's entry — this counter follows execution, not storage.
let runningCrawlJobs = 0;

function jobStoreMaxBytes(): number {
  const override = process.env.WIGOLO_SERVE_JOB_STORE_MAX_BYTES;
  if (override) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 100 * 1024 * 1024; // 100 MB
}

export interface CompatContext {
  subsystems: Subsystems;
  bindIsLoopback: boolean;
  /** Path after the `/compat/firecrawl` prefix, e.g. `/v1/scrape`. */
  subPath: string;
  respond: (status: number, body: unknown, headers?: Record<string, string>) => void;
}

interface CompatCrawlPage {
  markdown: string;
  metadata: { sourceURL: string; statusCode?: number };
}

type JobStatus = 'scraping' | 'completed' | 'failed';

interface CrawlJob {
  id: string;
  status: JobStatus;
  data: CompatCrawlPage[];
  total?: number;
  completed?: number;
  error?: string;
  /** Approximate stored payload size in bytes, for byte-pressure eviction. */
  bytes: number;
  /** Wall-clock ms when the job reached a terminal state (completed/failed). */
  settledAt?: number;
}

/**
 * In-memory crawl job store. NON-DURABLE — jobs are lost on restart; this is a
 * bench/compat convenience, not a durable queue. Bounded three ways:
 *  - LRU by entry count (JOB_COUNT_CAP)
 *  - total stored bytes (WIGOLO_SERVE_JOB_STORE_MAX_BYTES) with eviction on
 *    byte pressure (oldest first)
 *  - 30-min TTL for completed/failed jobs (swept lazily on access + on insert)
 * Insertion order in the Map is the LRU order (oldest first).
 */
export class CrawlJobStore {
  private readonly jobs = new Map<string, CrawlJob>();

  create(): CrawlJob {
    this.sweepExpired();
    const job: CrawlJob = { id: randomUUID(), status: 'scraping', data: [], bytes: 0 };
    this.jobs.set(job.id, job);
    this.enforceCountCap();
    return job;
  }

  get(id: string): CrawlJob | undefined {
    this.sweepExpired();
    return this.jobs.get(id);
  }

  /** Record the terminal payload for a job and enforce byte pressure. */
  settle(job: CrawlJob, next: Partial<CrawlJob>): void {
    Object.assign(job, next);
    job.settledAt = Date.now();
    job.bytes = Buffer.byteLength(JSON.stringify(job.data));
    this.enforceByteCap();
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.settledAt !== undefined && now - job.settledAt > JOB_TTL_MS) {
        this.jobs.delete(id);
      }
    }
  }

  private enforceCountCap(): void {
    while (this.jobs.size > JOB_COUNT_CAP) {
      const oldest = this.jobs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
    }
  }

  private enforceByteCap(): void {
    const cap = jobStoreMaxBytes();
    let total = 0;
    for (const job of this.jobs.values()) total += job.bytes;
    // Evict oldest entries until under the byte cap. Never evict the last
    // remaining job (a single oversized payload stays — bounded by body/clamp
    // limits upstream).
    while (total > cap && this.jobs.size > 1) {
      const oldestId = this.jobs.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      const oldest = this.jobs.get(oldestId)!;
      total -= oldest.bytes;
      this.jobs.delete(oldestId);
    }
  }

  /** Test-only introspection. */
  get size(): number {
    return this.jobs.size;
  }
}

// Module-level singleton so jobs persist across requests (non-durable).
const jobStore = new CrawlJobStore();

/** For tests: the shared job store instance. */
export function getJobStore(): CrawlJobStore {
  return jobStore;
}

/** A compat failure envelope: `{success:false, error}` at the mapped status. */
function fail(ctx: CompatContext, status: number, message: string): void {
  ctx.respond(status, { success: false, error: message });
}

/** Read + JSON-parse the request body under the shim's body cap. Returns a
 * structured error on parse failure / oversize (caller writes the compat error). */
async function readBody(
  req: IncomingMessage,
  tool: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; message: string }> {
  try {
    const parsed = await readJsonBodyCapped(req, bodyCapFor(tool));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, message: 'Request body must be a JSON object.' };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return { ok: false, status: 413, message: 'Request body exceeds the size cap.' };
    }
    return { ok: false, status: 400, message: 'Request body is not valid JSON.' };
  }
}

function requireUrl(body: Record<string, unknown>): string | null {
  const url = body.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/** Run the shared serve-mode target guard (literal + fetch-time resolved) on a
 * URL. Returns an error message on refusal (mapped to 400), or null when
 * allowed. */
async function guardUrl(ctx: CompatContext, url: string): Promise<string | null> {
  const guard = guardServeTarget(url, { bindIsLoopback: ctx.bindIsLoopback });
  if (!guard.ok) return guard.hint ? `${guard.reason} — ${guard.hint}` : guard.reason;

  // Fetch-time SSRF re-check. `guardServeTarget` only validates the LITERAL
  // host, so a public hostname whose DNS record points at a blocked address
  // (cloud metadata / RFC-1918 / loopback under a non-loopback bind) passes
  // it and is only caught here, before we connect. Skip literal IPs — already
  // validated. Same allowPrivate policy `guardServeTarget` used (config's
  // `fetchAllowPrivate` — it has no override param).
  const host = guard.url.hostname;
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isIpLiteral) return null;
  const resolved = await guardResolvedServeTarget(host, 'url', {
    allowPrivate: getConfig().fetchAllowPrivate,
    bindIsLoopback: ctx.bindIsLoopback,
  });
  if (resolved.ok) return null;
  return resolved.hint ? `${resolved.reason} — ${resolved.hint}` : resolved.reason;
}

function stageFailureMessage(f: StageFailure & { hint?: string }): string {
  return f.hint ? `${f.error} — ${f.hint}` : f.error;
}

// ── Route handlers ──────────────────────────────────────────────────────────

async function handleScrape(req: IncomingMessage, ctx: CompatContext): Promise<void> {
  const parsed = await readBody(req, 'fetch');
  if (!parsed.ok) return fail(ctx, parsed.status, parsed.message);
  const { body } = parsed;

  const url = requireUrl(body);
  if (!url) return fail(ctx, 400, 'A "url" string is required.');

  const guardErr = await guardUrl(ctx, url);
  if (guardErr) return fail(ctx, 400, guardErr);

  // formats: honour 'markdown' (the only format we produce). Unsupported
  // formats (html/rawHtml/screenshot/changeTracking/links/…) are ignored — we
  // return what we can. markdown is always included.
  const formats = Array.isArray(body.formats) ? body.formats : ['markdown'];
  const wantsUnsupported = formats.some((f) => typeof f === 'string' && !SUPPORTED_FORMATS.has(f));
  if (wantsUnsupported) {
    log.debug('scrape: ignoring unsupported formats', { formats });
  }

  const input: FetchInput = { url };
  const r = await handleFetch(input, ctx.subsystems.router);
  if (!r.ok) {
    return fail(ctx, statusForStageResult(r), stageFailureMessage(r));
  }
  const data = mapFetchToScrape(r.data);
  ctx.respond(200, { success: true, data });
}

function mapFetchToScrape(out: FetchOutput): { markdown: string; metadata: Record<string, unknown> } {
  const metadata: Record<string, unknown> = {
    sourceURL: out.url,
  };
  if (out.title) metadata.title = out.title;
  if (typeof out.http_status === 'number') metadata.statusCode = out.http_status;
  if (out.metadata.description) metadata.description = out.metadata.description;
  if (out.metadata.language) metadata.language = out.metadata.language;
  return { markdown: out.markdown ?? '', metadata };
}

async function handleSearchRoute(req: IncomingMessage, ctx: CompatContext): Promise<void> {
  const parsed = await readBody(req, 'search');
  if (!parsed.ok) return fail(ctx, parsed.status, parsed.message);
  const { body } = parsed;

  const query = body.query;
  if (typeof query !== 'string' || query.length === 0) {
    return fail(ctx, 400, 'A "query" string is required.');
  }

  let limit = SEARCH_LIMIT_DEFAULT;
  if (body.limit !== undefined) {
    const n = Number(body.limit);
    if (!Number.isFinite(n) || n <= 0) {
      return fail(ctx, 400, 'The "limit" must be a positive number.');
    }
    if (n > SEARCH_LIMIT_MAX) {
      return fail(ctx, 400, `The "limit" is capped at ${SEARCH_LIMIT_MAX} search results in this shim.`);
    }
    limit = Math.floor(n);
  }

  const input: SearchInput = { query, max_results: limit };
  const { searchEngines, router, backendStatus } = ctx.subsystems;
  const r = await handleSearch(
    input,
    searchEngines,
    router,
    backendStatus,
    undefined as unknown as SamplingCapableServer,
  );
  if (!r.ok) {
    return fail(ctx, statusForStageResult(r), stageFailureMessage(r));
  }
  const out = r.data as SearchOutput;
  if (typeof out.error === 'string' && out.error.length > 0) {
    return fail(ctx, 500, out.error);
  }
  const web = mapSearchToWeb(out, limit);
  ctx.respond(200, { success: true, data: { web } });
}

function mapSearchToWeb(
  out: SearchOutput,
  limit: number,
): Array<{ url: string; title: string; description: string }> {
  const results = Array.isArray(out.results) ? out.results : [];
  return results.slice(0, limit).map((r) => ({
    url: r.url,
    title: r.title ?? '',
    // Firecrawl's `description` ≈ the result snippet. wigolo-unique fields
    // (evidence_score, source_span, citation ids, …) are deliberately NOT
    // surfaced into the compat shape.
    description: pickSnippet(r as unknown as Record<string, unknown>),
  }));
}

function pickSnippet(r: Record<string, unknown>): string {
  const snippet = r.snippet ?? r.content ?? r.description ?? '';
  return typeof snippet === 'string' ? snippet : '';
}

async function handleMap(req: IncomingMessage, ctx: CompatContext): Promise<void> {
  const parsed = await readBody(req, 'crawl');
  if (!parsed.ok) return fail(ctx, parsed.status, parsed.message);
  const { body } = parsed;

  const url = requireUrl(body);
  if (!url) return fail(ctx, 400, 'A "url" string is required.');

  const guardErr = await guardUrl(ctx, url);
  if (guardErr) return fail(ctx, 400, guardErr);

  const limitErr = validateCrawlLimit(body);
  if (limitErr) return fail(ctx, 400, limitErr);
  const maxPages = clampCrawlLimit(body);

  const input: CrawlInput = { url, strategy: 'map', ...(maxPages !== undefined ? { max_pages: maxPages } : {}) };
  const result = await handleCrawl(input, ctx.subsystems.router);
  const mapResult = result as MapOutput;
  if (typeof mapResult.error === 'string' && mapResult.error.length > 0) {
    return fail(ctx, statusForCrawlCacheError(mapResult.error), mapResult.error);
  }
  const links = Array.isArray(mapResult.urls) ? mapResult.urls : [];
  ctx.respond(200, { success: true, data: { links } });
}

/** Validate a Firecrawl `limit` against the crawl max_pages clamp. Returns an
 * over-cap message or null. */
function validateCrawlLimit(body: Record<string, unknown>): string | null {
  if (body.limit === undefined) return null;
  const n = Number(body.limit);
  if (!Number.isFinite(n) || n <= 0) return 'The "limit" must be a positive number.';
  if (n > CRAWL_MAX_PAGES) {
    return `The "limit" is capped at ${CRAWL_MAX_PAGES} pages in serve mode.`;
  }
  return null;
}

function clampCrawlLimit(body: Record<string, unknown>): number | undefined {
  if (body.limit === undefined) return undefined;
  const n = Number(body.limit);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), CRAWL_MAX_PAGES);
}

async function handleCrawlStart(req: IncomingMessage, ctx: CompatContext): Promise<void> {
  const parsed = await readBody(req, 'crawl');
  if (!parsed.ok) return fail(ctx, parsed.status, parsed.message);
  const { body } = parsed;

  const url = requireUrl(body);
  if (!url) return fail(ctx, 400, 'A "url" string is required.');

  const guardErr = await guardUrl(ctx, url);
  if (guardErr) return fail(ctx, 400, guardErr);

  const limitErr = validateCrawlLimit(body);
  if (limitErr) return fail(ctx, 400, limitErr);
  const maxPages = clampCrawlLimit(body);

  // Concurrent-execution cap: the job-store caps bound storage, not running
  // work. Over the cap → refuse (429), never queue.
  const jobCap = maxCompatJobs();
  if (runningCrawlJobs >= jobCap) {
    ctx.respond(
      429,
      {
        success: false,
        error: `Too many crawl jobs are running (cap ${jobCap}). Retry after a short delay, or raise WIGOLO_SERVE_MAX_COMPAT_JOBS.`,
      },
      { 'Retry-After': '5' },
    );
    return;
  }

  const job = jobStore.create();
  const input: CrawlInput = { url, ...(maxPages !== undefined ? { max_pages: maxPages } : {}) };

  // Drive the crawl in the background; the client polls GET crawl/{id}. The
  // router's concurrency slot has already been released for this request (the
  // POST returns immediately); concurrent background crawls are bounded by
  // runningCrawlJobs + the crawl clamps, storage by the job-store caps.
  runningCrawlJobs++;
  void handleCrawl(input, ctx.subsystems.router)
    .then((result) => {
      const crawl = result as CrawlOutput;
      if (typeof crawl.error === 'string' && crawl.error.length > 0) {
        jobStore.settle(job, { status: 'failed', error: crawl.error });
        return;
      }
      const pages: CompatCrawlPage[] = (crawl.pages ?? []).map((p) => ({
        markdown: p.markdown ?? '',
        metadata: { sourceURL: p.url },
      }));
      jobStore.settle(job, {
        status: 'completed',
        data: pages,
        total: crawl.total_found ?? pages.length,
        completed: pages.length,
      });
    })
    .catch((err: unknown) => {
      log.error('background crawl failed', { id: job.id, error: String(err) });
      jobStore.settle(job, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      if (runningCrawlJobs > 0) runningCrawlJobs--;
    });

  ctx.respond(200, { success: true, id: job.id });
}

function handleCrawlStatus(id: string, ctx: CompatContext): void {
  const job = jobStore.get(id);
  if (!job) {
    return fail(ctx, 404, 'No such crawl job. Jobs are in-memory and non-durable.');
  }
  const payload: Record<string, unknown> = { status: job.status };
  if (job.status === 'completed') {
    payload.total = job.total ?? job.data.length;
    payload.completed = job.completed ?? job.data.length;
    payload.data = job.data;
  } else if (job.status === 'failed') {
    payload.error = job.error ?? 'crawl failed';
    payload.data = [];
  }
  ctx.respond(200, payload);
}

/**
 * Handle a `/compat/firecrawl/*` request. Returns true when the request was
 * handled (response written). Auth + flag-gating already ran in the router.
 */
export async function handleCompatRequest(
  req: IncomingMessage,
  _res: ServerResponse,
  ctx: CompatContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const sub = ctx.subPath.replace(/\/+$/, '') || '/';

  // GET /v1/crawl/{id}
  const statusMatch = sub.match(/^\/v1\/crawl\/([^/]+)$/);
  if (statusMatch) {
    if (method !== 'GET') {
      fail(ctx, 405, 'Method not allowed; use GET to poll a crawl job.');
      return true;
    }
    handleCrawlStatus(decodeURIComponent(statusMatch[1]), ctx);
    return true;
  }

  // POST routes.
  if (method !== 'POST') {
    fail(ctx, 405, 'Method not allowed; use POST.');
    return true;
  }

  switch (sub) {
    case '/v1/scrape':
      await handleScrape(req, ctx);
      return true;
    case '/v1/search':
      await handleSearchRoute(req, ctx);
      return true;
    case '/v1/map':
      await handleMap(req, ctx);
      return true;
    case '/v1/crawl':
      await handleCrawlStart(req, ctx);
      return true;
    default:
      fail(ctx, 404, 'No such Firecrawl-compat route.');
      return true;
  }
}
