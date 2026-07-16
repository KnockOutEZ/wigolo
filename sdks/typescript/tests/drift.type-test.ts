/**
 * Type-level drift guard. Compiled by `tsc --noEmit` (the `npm test` type leg),
 * NOT executed by vitest — its assertions are types, and any drift between the
 * runtime manifest and the request/response interfaces is a COMPILE error here.
 *
 * For each tool it asserts, bidirectionally:
 *   - manifest[tool].params            === keyof XRequest
 *   - manifest[tool].responseKeys      === KnownKeys<XResponse>
 *
 * `KnownKeys<T>` drops the open string index signature so the extras bag does
 * not swallow the check into a vacuous always-true. The `as const` manifest
 * makes `params[number]` a literal union.
 */
import { manifest } from '../src/manifest.js';
import type {
  SearchRequest,
  SearchResponse,
  FetchRequest,
  FetchResponse,
  CrawlRequest,
  CrawlResponse,
  CacheRequest,
  CacheResponse,
  ExtractRequest,
  ExtractResponse,
  FindSimilarRequest,
  FindSimilarResponse,
  ResearchRequest,
  ResearchResponse,
  AgentRequest,
  AgentResponse,
  DiffRequest,
  DiffResponse,
  WatchRequest,
  WatchResponse,
} from '../src/types.js';

/** Bidirectional type equality. */
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Known (non-index-signature) keys of T. */
type KnownKeys<T> = keyof {
  [K in keyof T as string extends K ? never : K]: T[K];
};

/** Fails to compile unless the argument is exactly `true`. */
function expectTrue<_T extends true>(): void {
  /* type-level only */
}

type SearchParams = (typeof manifest)['search']['params'][number];
type FetchParams = (typeof manifest)['fetch']['params'][number];
type CrawlParams = (typeof manifest)['crawl']['params'][number];
type CacheParams = (typeof manifest)['cache']['params'][number];
type ExtractParams = (typeof manifest)['extract']['params'][number];
type FindSimilarParams = (typeof manifest)['find_similar']['params'][number];
type ResearchParams = (typeof manifest)['research']['params'][number];
type AgentParams = (typeof manifest)['agent']['params'][number];
type DiffParams = (typeof manifest)['diff']['params'][number];
type WatchParams = (typeof manifest)['watch']['params'][number];

type SearchResKeys = (typeof manifest)['search']['responseKeys'][number];
type FetchResKeys = (typeof manifest)['fetch']['responseKeys'][number];
type CrawlResKeys = (typeof manifest)['crawl']['responseKeys'][number];
type CacheResKeys = (typeof manifest)['cache']['responseKeys'][number];
type ExtractResKeys = (typeof manifest)['extract']['responseKeys'][number];
type FindSimilarResKeys = (typeof manifest)['find_similar']['responseKeys'][number];
type ResearchResKeys = (typeof manifest)['research']['responseKeys'][number];
type AgentResKeys = (typeof manifest)['agent']['responseKeys'][number];
type DiffResKeys = (typeof manifest)['diff']['responseKeys'][number];
type WatchResKeys = (typeof manifest)['watch']['responseKeys'][number];

// ---- request param drift ----
expectTrue<Eq<SearchParams, keyof SearchRequest>>();
expectTrue<Eq<FetchParams, keyof FetchRequest>>();
expectTrue<Eq<CrawlParams, keyof CrawlRequest>>();
expectTrue<Eq<CacheParams, keyof CacheRequest>>();
expectTrue<Eq<ExtractParams, keyof ExtractRequest>>();
expectTrue<Eq<FindSimilarParams, keyof FindSimilarRequest>>();
expectTrue<Eq<ResearchParams, keyof ResearchRequest>>();
expectTrue<Eq<AgentParams, keyof AgentRequest>>();
expectTrue<Eq<DiffParams, keyof DiffRequest>>();
expectTrue<Eq<WatchParams, keyof WatchRequest>>();

// ---- response known-key drift ----
expectTrue<Eq<SearchResKeys, KnownKeys<SearchResponse>>>();
expectTrue<Eq<FetchResKeys, KnownKeys<FetchResponse>>>();
expectTrue<Eq<CrawlResKeys, KnownKeys<CrawlResponse>>>();
expectTrue<Eq<CacheResKeys, KnownKeys<CacheResponse>>>();
expectTrue<Eq<ExtractResKeys, KnownKeys<ExtractResponse>>>();
expectTrue<Eq<FindSimilarResKeys, KnownKeys<FindSimilarResponse>>>();
expectTrue<Eq<ResearchResKeys, KnownKeys<ResearchResponse>>>();
expectTrue<Eq<AgentResKeys, KnownKeys<AgentResponse>>>();
expectTrue<Eq<DiffResKeys, KnownKeys<DiffResponse>>>();
expectTrue<Eq<WatchResKeys, KnownKeys<WatchResponse>>>();
