/**
 * The two library stages the companion broker injects (`wigolo/companion-stages`).
 *
 * `packages/studio-core`'s `createBrokerHandlers` takes `findSimilar` (local-corpus search) and
 * `buildBrief` (the research-brief shaper) as INJECTED stages rather than importing them, because
 * neither was reachable from a published specifier: `wigolo/search-tokens` publishes `countTokens`
 * alone and the root export is the CLI's `main`. Left undefined, the knowledge rail answers `[]` and
 * `synthesizeSession` refuses — the degraded state EXTRACT D1 shipped.
 *
 * WHY A FACTORY AND NOT A RE-EXPORT. `findSimilar(input, engines, router, backendStatus)` takes three
 * constructed collaborators, none of which core exports and none of which a consumer could build
 * without importing the engine classes, the browser pool and the HTTP client — i.e. without
 * re-deriving `initSubsystems`. Publishing the raw function would move that construction into the
 * consumer, where it would drift from core's. The factory closes over core's own construction and
 * hands back exactly the arity the broker's `BrokerStages` declares.
 *
 * WHAT THIS MODULE DOES NOT OWN. It never opens a database. In the paired install the broker child
 * already holds the shared cache open (its `openDatabase()` guards on `isDatabaseInitialized`), and a
 * second `initDatabase` here would be a second handle minted by the side that does not own the file.
 * The stages read through core's global cache handle, so the HOST opens it first — the ordering is
 * the caller's, and a stage called before it fails loudly rather than answering an empty corpus.
 */
import type {
  FindSimilarInput,
  FindSimilarOutput,
  ResearchBrief,
  ResearchSource,
  SearchEngine,
} from '../types.js';
import { SmartRouter, type HttpClient } from '../fetch/router.js';
import { MultiBrowserPool } from '../fetch/browser-pool.js';
import { httpFetch } from '../fetch/http-client.js';
import { BingEngine } from '../search/engines/bing.js';
import { DuckDuckGoEngine } from '../search/engines/duckduckgo.js';
import { BackendStatus } from '../server/backend-status.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { getConfig } from '../config.js';
import { handleFindSimilar } from '../tools/find-similar.js';
import { buildResearchBrief } from '../research/brief.js';
import { createLogger } from '../logger.js';

const log = createLogger('companion');

/** Exactly the shape `BrokerStages.findSimilar` declares, with core's collaborators bound. */
export type FindSimilarStage = (input: FindSimilarInput) => Promise<FindSimilarOutput>;

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
 * Build the local-corpus search stage over core's own collaborators.
 *
 * Construction is EAGER for the router, engines and backend status (all three are cheap object
 * literals — the browser pool launches nothing until a fetch needs a browser) and LAZY, once, for the
 * embedding service, whose init provisions the vector store and runs the legacy migration. A failed
 * embedding init is warned and swallowed exactly as `initSubsystems` swallows it: the FTS5 lane still
 * answers, and a rail that returns keyword hits beats a rail that returns nothing.
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
  const httpClient: HttpClient = {
    fetch: (url, init) => httpFetch(url, init),
  };
  const browserPool = new MultiBrowserPool({
    browserTypes: getConfig().browserTypes,
    selectionStrategy: 'round-robin',
  });
  const router = new SmartRouter(httpClient, browserPool);
  const backendStatus = new BackendStatus();
  const engines: SearchEngine[] = [new BingEngine(), new DuckDuckGoEngine()];

  let embeddingReady: Promise<void> | undefined;
  const ensureEmbedding = (): Promise<void> => {
    if (options.skipEmbeddingInit) return Promise.resolve();
    embeddingReady ??= getEmbeddingService()
      .init()
      .then(() => undefined)
      .catch((err: unknown) => {
        log.warn('embedding service init failed, find_similar stage runs without the embedding path', {
          error: String(err),
        });
      });
    return embeddingReady;
  };

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
