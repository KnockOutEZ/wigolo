/**
 * The library stages the companion broker injects (`wigolo/companion-stages`).
 *
 * `packages/studio-core`'s `createBrokerHandlers` takes `findSimilar` (local-corpus search), `search`
 * (the in-app SERP's web search) and `buildBrief` (the research-brief shaper) as INJECTED stages
 * rather than importing them, because none was reachable from a published specifier:
 * `wigolo/search-tokens` publishes `countTokens` alone and the root export is the CLI's `main`. Left
 * undefined, the knowledge rail answers `[]`, `serpSearch` refuses in words and `synthesizeSession`
 * refuses — the degraded state EXTRACT D1 shipped and #366 re-hit for the SERP.
 *
 * WHY A FACTORY AND NOT A RE-EXPORT. `findSimilar(input, engines, router, backendStatus)` and
 * `handleSearch(input, engines, router, backendStatus)` each take constructed collaborators, none of
 * which core exports and none of which a consumer could build without importing the engine classes,
 * the browser pool and the HTTP client — i.e. without re-deriving `initSubsystems`. Publishing the raw
 * functions would move that construction into the consumer, where it would drift from core's. The
 * factories close over core's own construction and hand back exactly the arities the broker's
 * `BrokerStages` declares.
 *
 * WHAT THIS MODULE DOES NOT OWN. It never opens a database. In the paired install the broker child
 * already holds the shared cache open (its `openDatabase()` guards on `isDatabaseInitialized`), and a
 * second `initDatabase` here would be a second handle minted by the side that does not own the file.
 * The stages read through core's global cache handle, so the HOST opens it first — the ordering is
 * the caller's, and a stage called before it fails loudly rather than answering an empty corpus.
 */
import type {
  ExtractInput,
  ExtractOutput,
  FindSimilarInput,
  FindSimilarOutput,
  ResearchBrief,
  ResearchSource,
  SearchEngine,
  SearchInput,
  SearchOutput,
} from '../types.js';
import { SmartRouter, type HttpClient } from '../fetch/router.js';
import { MultiBrowserPool } from '../fetch/browser-pool.js';
import { httpFetch } from '../fetch/http-client.js';
import { BingEngine } from '../search/engines/bing.js';
import { DuckDuckGoEngine } from '../search/engines/duckduckgo.js';
import { BackendStatus } from '../server/backend-status.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { getConfig } from '../config.js';
import { handleExtract } from '../tools/extract.js';
import { handleFindSimilar } from '../tools/find-similar.js';
import { handleSearch } from '../tools/search.js';
import { buildResearchBrief } from '../research/brief.js';
import { createLogger } from '../logger.js';

const log = createLogger('companion');

/** Exactly the shape `BrokerStages.findSimilar` declares, with core's collaborators bound. */
export type FindSimilarStage = (input: FindSimilarInput) => Promise<FindSimilarOutput>;

/**
 * Exactly the shape `BrokerStages.search` declares — one argument, the tool's own `SearchInput`, so
 * the app side is a wiring line and re-types nothing.
 *
 * The input crosses UNRESHAPED, which is what makes `search_depth` honoured rather than
 * re-implemented: the depth tier changes reranking and content-fetch budgets deep inside the core
 * provider, so a stage that normalised or dropped the field would silently answer at `balanced` while
 * the SERP's own header said `deep`. The output crosses unreshaped for the mirror-image reason — the
 * SERP view renders per-result `evidence_score` with its component breakdown, and a projection here
 * would strip the explanation the view exists to show.
 */
export type SearchStage = (input: SearchInput) => Promise<SearchOutput>;

/**
 * Exactly the shape `BrokerStages.buildBrief` declares: four arguments, no sub-queries and no query
 * type. Session synthesis shapes bodies that are ALREADY gathered, so there is no decomposition to
 * report and nothing for a comparison shaping to compare — see {@link createBriefStage}.
 */
export type BriefStage = (
  question: string,
  sources: ResearchSource[],
  perSourceCharCap: number,
  totalSourcesCharCap: number,
) => Promise<ResearchBrief>;

export interface FindSimilarStageOptions {
  /**
   * Skip the lazy embedding-service init. The hybrid lane degrades to FTS5 alone without it, so this
   * exists for a caller that has already run `initSubsystems()` in-process, not as a tuning knob.
   */
  skipEmbeddingInit?: boolean;
}

export interface SearchStageOptions {
  /**
   * Skip the lazy embedding-service init. Without it the search path still answers — the init
   * provisions the vector store the content-fetch lane embeds into, it is not a ranking input — so
   * this exists for a caller that has already run `initSubsystems()` in-process, not as a tuning knob.
   */
  skipEmbeddingInit?: boolean;
}

/**
 * Raised when the stage refuses. The broker turns a throw into an RPC error the app catches, which is
 * the honest shape: `knowledgeSimilar` degrades to `[]` on a refusal it can see, never on a silently
 * empty result it cannot tell from a cold corpus.
 */
export class FindSimilarStageError extends Error {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'FindSimilarStageError';
  }
}

/**
 * Raised when the search stage refuses — same reason {@link FindSimilarStageError} exists, and a
 * separate class because the SERP has to tell "the query was rejected" apart from "the corpus rail
 * refused" without string-matching a message. An empty `SearchOutput` is a legitimate answer (a real
 * query the engines had nothing for), so a refusal must never arrive as one.
 */
export class SearchStageError extends Error {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'SearchStageError';
  }
}

/** The collaborator set every stage binds — core's own construction, minus what `initSubsystems`
 * owns and a stage must not: the database, the telemetry timer and the plugin registry. */
interface StageCollaborators {
  engines: SearchEngine[];
  router: SmartRouter;
  backendStatus: BackendStatus;
}

/**
 * Construction is EAGER and cheap: the router, the two built-in engines and the backend status are
 * object literals, and the browser pool launches nothing until a fetch needs a browser.
 */
function buildCollaborators(): StageCollaborators {
  const httpClient: HttpClient = {
    fetch: (url, init) => httpFetch(url, init),
  };
  const browserPool = new MultiBrowserPool({
    browserTypes: getConfig().browserTypes,
    selectionStrategy: 'round-robin',
  });
  return {
    engines: [new BingEngine(), new DuckDuckGoEngine()],
    router: new SmartRouter(httpClient, browserPool),
    backendStatus: new BackendStatus(),
  };
}

/**
 * A once-per-factory gate over the embedding init, whose work provisions the vector store and runs the
 * legacy migration. A failure is warned and swallowed exactly as `initSubsystems` swallows it: the
 * FTS5 lane still answers, and a rail that returns keyword hits beats a rail that returns nothing.
 */
function createEmbeddingGate(stage: string, skip: boolean | undefined): () => Promise<void> {
  let ready: Promise<void> | undefined;
  return () => {
    if (skip) return Promise.resolve();
    ready ??= getEmbeddingService()
      .init()
      .then(() => undefined)
      .catch((err: unknown) => {
        log.warn(`embedding service init failed, ${stage} stage runs without the embedding path`, {
          error: String(err),
        });
      });
    return ready;
  };
}

/**
 * Build the local-corpus search stage over core's own collaborators.
 *
 * The call goes through the TOOL handler, not the raw pipeline, on purpose. `handleFindSimilar` runs
 * the SSRF guard on a `url` seed — and the seed arrives over the broker wire from a page the agent was
 * looking at, so it is exactly the attacker-adjacent input that guard exists for (law 12: policy is
 * enforced outside the model). The handler's `StageResult` envelope is unwrapped here rather than
 * passed on, because the broker's own contract is "the stage's answer, or a throw".
 */
export function createFindSimilarStage(
  options: FindSimilarStageOptions = {},
): FindSimilarStage {
  const { engines, router, backendStatus } = buildCollaborators();
  const ensureEmbedding = createEmbeddingGate('find_similar', options.skipEmbeddingInit);

  return async (input: FindSimilarInput): Promise<FindSimilarOutput> => {
    await ensureEmbedding();
    const result = await handleFindSimilar(input, engines, router, backendStatus);
    if (!result.ok) {
      throw new FindSimilarStageError(result.error, result.error_reason ?? result.error);
    }
    return result.data;
  };
}

/**
 * Build the web-search stage the in-app SERP runs on, over core's own collaborators.
 *
 * The call goes through the TOOL handler for the same reason the corpus stage does, plus one of its
 * own: `handleSearch` is where the configured provider is selected (`core` by default, `searxng` and
 * `hybrid` opt-in via `WIGOLO_SEARCH`). Binding the v1 orchestrator directly would hard-wire the SERP
 * to one backend and make the app the second place that decision is made.
 *
 * NO RUN IS CREATED HERE and none can be: a SERP query is the user's own navigation, not an agent
 * task (A-18-3). This module holds no run store, appends no event and mints no id — the stage is a
 * function from a query to results, and the surface that would attribute it does not exist on this
 * side of the wire.
 *
 * The input and the output both cross UNRESHAPED — see {@link SearchStage} for why `search_depth` and
 * `evidence_score` make that a contract rather than laziness.
 */
export function createSearchStage(options: SearchStageOptions = {}): SearchStage {
  const { engines, router, backendStatus } = buildCollaborators();
  const ensureEmbedding = createEmbeddingGate('search', options.skipEmbeddingInit);

  return async (input: SearchInput): Promise<SearchOutput> => {
    await ensureEmbedding();
    // No sampling server and no progress callback: the SERP has no MCP sampling peer to synthesize an
    // answer through, and nothing on the IPC path can consume a progress tick — passing either would
    // advertise a capability the surface does not have.
    const result = await handleSearch(input, engines, router, backendStatus);
    if (!result.ok) {
      throw new SearchStageError(result.error, result.error_reason ?? result.error);
    }
    return result.data;
  };
}

/**
 * Build the brief-shaping stage.
 *
 * `buildResearchBrief` carries the research pipeline's full arity — sub-queries, query type,
 * comparison entities, an optional synthesis body. Session synthesis supplies none of them and cannot:
 * it shapes bodies the agent already captured, so there was no decomposition step to report as
 * sub-queries and no comparison to name entities for. The adapter pins those to the pipeline's own
 * defaults (`[]` / `'general'` / `[]`) so the broker's four-argument stage type is the whole surface a
 * consumer sees, and a later argument added to the pipeline does not silently change what the rail
 * asks for.
 *
 * No network and no decomposition→search→fetch: the shaper only reads the sources it is handed.
 */
export function createBriefStage(): BriefStage {
  return (question, sources, perSourceCharCap, totalSourcesCharCap) =>
    buildResearchBrief(question, sources, [], perSourceCharCap, totalSourcesCharCap, 'general', []);
}

/**
 * Exactly what a session-targeted extract needs, and nothing that would let it do more.
 *
 * `url`, `execution_mode` and `session_id` are absent BY CONSTRUCTION. The host is already on the
 * page and already holds its settled DOM, so there is nothing here to navigate to — and a stage that
 * could navigate would be a second fetcher living behind the broker's RPC surface with none of the
 * fetch tool's guards in front of it. Every other knob the ephemeral tool takes crosses unchanged,
 * because the point of this seam is that the two paths answer the same thing.
 */
export interface ExtractStageRequest
  extends Omit<ExtractInput, 'url' | 'html' | 'execution_mode' | 'session_id'> {
  /** The settled DOM the host captured from the live session's current page. */
  html: string;
  /**
   * The live page's address, reported back as `ExtractOutput.source_url`. It is PROVENANCE and never
   * a target: nothing reads it, resolves it or fetches it. Omitted, the answer names no page —
   * exactly what the ephemeral tool's raw-HTML call does.
   */
  source_url?: string;
}

/** Exactly the arity the broker's extract stage declares — one request, one `ExtractOutput`. */
export type ExtractStage = (request: ExtractStageRequest) => Promise<ExtractOutput>;

/**
 * Raised when the extract stage refuses — same reason the two above exist, plus one specific to this
 * tool: an EMPTY payload is a legitimate extract answer (a page with no tables in a mode that finds
 * none, a schema whose fields are genuinely absent), so a refusal that arrived as one would be
 * unreadable. `hint` is carried because extract's own refusals ship recovery instructions with them,
 * and dropping the instruction turns an actionable refusal into a dead end.
 */
export class ExtractStageError extends Error {
  constructor(
    readonly code: string,
    reason: string,
    readonly hint?: string,
  ) {
    super(reason);
    this.name = 'ExtractStageError';
  }
}

/**
 * Build the session-targeted extract stage over core's own collaborators.
 *
 * WHY THIS EXISTS AT ALL. The app's session-target wire runs `extract` on the HOST, against the live
 * session's current page — but no published subpath reached core's mode dispatch, so the app served
 * `metadata` and answered the other five modes with a refusal on `ExtractOutput`'s fail-as-data
 * channel. Honest, and still a half-live tool. This is the door that closes that gap without the app
 * growing a second extraction pipeline beside core's (D11's shared-schema tax stays paid once).
 *
 * THE CALL GOES THROUGH THE TOOL HANDLER, not the extractors underneath, for the same reason the
 * search and corpus stages do: `handleExtract` is where the mode dispatch, the input validation, the
 * named-schema table, the token clamp and the structure-first schema ladder all live. Binding the
 * extractors directly would move every one of those decisions into the consumer, where the session
 * answer would drift from the ephemeral answer field by field — which is precisely the drift this
 * stage exists to end.
 *
 * IT CANNOT NAVIGATE. `ExtractStageRequest` carries no `url`, so `handleExtract`'s resolve step takes
 * the raw-HTML branch every time: no cache read, no router fetch, no browser tier. The router below is
 * bound because the handler's signature takes one, and it is unreachable on this path by construction
 * — the honest shape for a seam whose whole input is a DOM the host already has.
 */
export function createExtractStage(): ExtractStage {
  const { router } = buildCollaborators();

  return async ({ html, source_url, ...rest }: ExtractStageRequest): Promise<ExtractOutput> => {
    // `'agent'` is the conservative source: the navigation guard it selects is unreachable without a
    // url, so it costs nothing, and it is the verdict this seam should get if a url ever appears.
    const result = await handleExtract({ ...rest, html }, router, 'agent');
    if (!result.ok) {
      throw new ExtractStageError(result.error, result.error_reason ?? result.error, result.hint);
    }
    return source_url === undefined ? result.data : { ...result.data, source_url };
  };
}
