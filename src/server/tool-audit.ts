/**
 * D10 — non-studio tool-invocation audit (LEAF).
 *
 * Records every NON-studio_* MCP tool call into the append-only `tool_audit` table for forensics:
 * which tool ran, a privacy-projected slice of its args, the outcome, and how long it took. The
 * studio_* tools are excluded at the wrap (server.ts) — they carry their own richer studio_audit.
 *
 * This module holds two jobs and nothing else (it is a true leaf — no global-DB reach, the handle
 * is injected by the host, mirroring src/studio/audit.ts):
 *
 *  1. PRIVACY-AS-A-TYPE (fail-closed). `projectToolArgs` maps a raw call to a CLOSED per-tool shape.
 *     Sensitive inputs are UNREPRESENTABLE in the return type, not stripped at runtime — adding e.g.
 *     `headers` (fetch) or `prompt` (agent) to a projection literal is a compile error. Posture:
 *       - free-text user intent (search.query, cache.query/url_pattern, find_similar.concept,
 *         research.question, agent.prompt) is OMITTED;
 *       - target URLs are reduced to scheme+host+path (query+fragment STRIPPED);
 *       - raw page bodies (extract.html), typed text (fetch.actions[].text), webhook URLs/tokens
 *         (watch.notification), selectors, request headers, and api keys are never representable;
 *       - what remains is tool name, host/path, mode/depth/flags, outcome, ts, duration.
 *     Anything genuinely ambiguous fails CLOSED (omitted).
 *
 *  2. A best-effort, non-throwing, INSERT-only writer. `recordToolCall` swallows any DB error so a
 *     torn-down / read-only handle can never corrupt the tool result it trails (mirrors
 *     scheduleOverdueCheck / the sendNotification swallow). It is the SOLE writer and never mutates.
 */
import { createLogger } from '../logger.js';
import type { FetchInput, SearchInput, CrawlInput, CacheInput, ExtractInput, FindSimilarInput, ResearchInput, AgentInput, WatchJobInput } from '../types.js';

const log = createLogger('server');

/** The narrow DB surface the writer needs. A real better-sqlite3 Database satisfies it structurally;
 *  the handle is INJECTED (never imported) so this stays a leaf. */
export interface ToolAuditDb {
  prepare(sql: string): { run(...args: unknown[]): unknown };
}

// ---- CLOSED per-tool projections. NO index signature → sensitive fields are unrepresentable. ----

interface FetchArgsMeta {
  url?: string;
  render_js?: FetchInput['render_js'];
  use_auth?: boolean;
  force_refresh?: boolean;
  screenshot?: boolean;
  mode?: FetchInput['mode'];
}
interface SearchArgsMeta {
  category?: SearchInput['category'];
  time_range?: SearchInput['time_range'];
  search_depth?: SearchInput['search_depth'];
  exact_match?: boolean;
  country?: string;
  format?: SearchInput['format'];
  max_results?: number;
}
interface CrawlArgsMeta {
  url?: string;
  strategy?: CrawlInput['strategy'];
  max_depth?: number;
  max_pages?: number;
  use_auth?: boolean;
}
interface CacheArgsMeta {
  mode?: CacheInput['mode'];
  stats?: boolean;
  clear?: boolean;
  check_changes?: boolean;
  limit?: number;
  since?: string;
}
interface ExtractArgsMeta {
  url?: string;
  mode?: ExtractInput['mode'];
  multiple?: boolean;
  named_schema?: ExtractInput['named_schema'];
}
interface FindSimilarArgsMeta {
  url?: string;
  mode?: FindSimilarInput['mode'];
  max_results?: number;
  include_cache?: boolean;
  include_web?: boolean;
  threshold?: number;
}
interface ResearchArgsMeta {
  depth?: ResearchInput['depth'];
  max_sources?: number;
}
interface AgentArgsMeta {
  max_pages?: number;
  max_time_ms?: number;
  url_count?: number;
}
interface DiffArgsMeta {
  output?: string;
  granularity?: string;
}
interface WatchArgsMeta {
  action?: WatchJobInput['action'];
  url?: string;
  url_count?: number;
  interval_seconds?: number;
  job_id?: string;
}

export type ToolArgsMeta =
  | FetchArgsMeta | SearchArgsMeta | CrawlArgsMeta | CacheArgsMeta | ExtractArgsMeta
  | FindSimilarArgsMeta | ResearchArgsMeta | AgentArgsMeta | DiffArgsMeta | WatchArgsMeta;

/** Reduce a URL to scheme+host+path, dropping query + fragment. Returns undefined (fail-closed) when
 *  the value is missing or unparseable — a malformed string is never logged raw. */
function stripUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function countOf(v: unknown): number | undefined {
  return Array.isArray(v) ? v.length : undefined;
}

/**
 * Project a raw tool call onto its CLOSED metadata shape. Returns undefined for unknown tools (no
 * shape assumed). The argument is the raw MCP arguments object; each branch reads ONLY the safe
 * structural fields named in that tool's projection type.
 */
export function projectToolArgs(tool: string, args: Record<string, unknown>): ToolArgsMeta | undefined {
  switch (tool) {
    case 'fetch': {
      const a = args as Partial<FetchInput>;
      return { url: stripUrl(a.url), render_js: a.render_js, use_auth: asBool(a.use_auth), force_refresh: asBool(a.force_refresh), screenshot: asBool(a.screenshot), mode: a.mode };
    }
    case 'search': {
      const a = args as Partial<SearchInput>;
      return { category: a.category, time_range: a.time_range, search_depth: a.search_depth, exact_match: asBool(a.exact_match), country: asStr(a.country), format: a.format, max_results: asNum(a.max_results) };
    }
    case 'crawl': {
      const a = args as Partial<CrawlInput>;
      return { url: stripUrl(a.url), strategy: a.strategy, max_depth: asNum(a.max_depth), max_pages: asNum(a.max_pages), use_auth: asBool(a.use_auth) };
    }
    case 'cache': {
      const a = args as Partial<CacheInput>;
      return { mode: a.mode, stats: asBool(a.stats), clear: asBool(a.clear), check_changes: asBool(a.check_changes), limit: asNum(a.limit), since: asStr(a.since) };
    }
    case 'extract': {
      const a = args as Partial<ExtractInput>;
      return { url: stripUrl(a.url), mode: a.mode, multiple: asBool(a.multiple), named_schema: a.named_schema };
    }
    case 'find_similar': {
      const a = args as Partial<FindSimilarInput>;
      return { url: stripUrl(a.url), mode: a.mode, max_results: asNum(a.max_results), include_cache: asBool(a.include_cache), include_web: asBool(a.include_web), threshold: asNum(a.threshold) };
    }
    case 'research': {
      const a = args as Partial<ResearchInput>;
      return { depth: a.depth, max_sources: asNum(a.max_sources) };
    }
    case 'agent': {
      const a = args as Partial<AgentInput>;
      return { max_pages: asNum(a.max_pages), max_time_ms: asNum(a.max_time_ms), url_count: countOf(a.urls) };
    }
    case 'diff': {
      return { output: asStr(args.output), granularity: asStr(args.granularity) };
    }
    case 'watch': {
      const a = args as Partial<WatchJobInput>;
      return { action: a.action, url: stripUrl(a.url), url_count: countOf(a.urls), interval_seconds: asNum(a.interval_seconds), job_id: asStr(a.job_id) };
    }
    default:
      return undefined;
  }
}

/** One tool-call audit record. `argsMeta` is the privacy-projected shape (or undefined). */
export interface ToolCallRecord {
  tool: string;
  argsMeta?: ToolArgsMeta;
  outcomeOk: boolean;
  errorReason?: string;
  ts: number;
  durationMs: number;
}

/**
 * The SOLE writer: a single INSERT into the append-only tool_audit table. Best-effort — a missing or
 * throwing handle is swallowed (debug-logged) so an audit-write failure can never corrupt or fail the
 * tool result it trails. INSERT-only; this module exposes no UPDATE/DELETE path.
 */
export function recordToolCall(db: ToolAuditDb | undefined, rec: ToolCallRecord): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO tool_audit (tool, args_meta, outcome_ok, error_reason, ts, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.tool,
      rec.argsMeta ? JSON.stringify(rec.argsMeta) : null,
      rec.outcomeOk ? 1 : 0,
      rec.errorReason ?? null,
      rec.ts,
      rec.durationMs,
    );
  } catch (err) {
    log.debug('tool audit record failed', { error: String(err) });
  }
}
