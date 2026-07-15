import type {
  SearchProvider,
  SearchContext,
} from '../../providers/search-provider.js';
import type {
  SearchInput,
  SearchOutput,
  StageResult,
} from '../../types.js';
import { createLogger } from '../../logger.js';
import { evaluateSignals } from './signals.js';
import { mergeResults } from './merge.js';

const log = createLogger('hybrid');

/**
 * Actionable message surfaced per-request when a fallback signal fires in
 * hybrid mode but the search-engine sidecar is not available. Names BOTH fixes
 * because stderr boot lines are invisible to MCP callers (D1). Capability
 * language only.
 */
const SIDECAR_UNAVAILABLE_WARNING =
  'A stronger fallback search was wanted but the search engine sidecar is not available. ' +
  'To enable it, set WIGOLO_SEARXNG_URL to an external instance, or run `wigolo warmup --searxng` to install it.';

export class HybridSearchProvider implements SearchProvider {
  readonly name = 'hybrid' as const;

  constructor(
    private readonly core: SearchProvider,
    private readonly searxng: SearchProvider,
    /**
     * Whether the sidecar can actually serve the fallback (external URL or an
     * installed, ready process). Defaults true so the merge path is exercised
     * unchanged; when false and a signal fires, the fallback is SKIPPED and a
     * per-request warning is attached instead (D1 degrade).
     */
    private readonly searxngAvailable: boolean = true,
  ) {}

  async search(
    input: SearchInput,
    ctx: SearchContext,
  ): Promise<StageResult<SearchOutput>> {
    const coreResult = await this.core.search(input, ctx);
    if (!coreResult.ok) {
      log.warn('core search failed; not running fallback', {
        error: coreResult.error,
        reason: coreResult.error_reason,
      });
      return coreResult;
    }

    const fired = evaluateSignals(input, coreResult.data);

    if (fired.length === 0) {
      log.debug('no fallback signal fired; returning core result');
      return {
        ok: true,
        data: { ...coreResult.data, fallback_signal: null },
      };
    }

    const signalLabel = fired.join('+');

    // D1 degrade: a signal fired but the sidecar can't serve the fallback. Skip
    // it and surface a per-request, actionable warning rather than searching
    // with empty engines (which returns junk).
    if (!this.searxngAvailable) {
      log.warn('fallback signal fired but search engine sidecar unavailable; skipping fallback', {
        signals: fired,
      });
      const data: SearchOutput = { ...coreResult.data, fallback_signal: signalLabel };
      if (!data.warning) data.warning = SIDECAR_UNAVAILABLE_WARNING;
      return { ok: true, data };
    }

    log.info('fallback signal fired; running searxng', { signals: fired });

    let searxngResult: StageResult<SearchOutput>;
    try {
      searxngResult = await this.searxng.search(input, ctx);
    } catch (err) {
      log.warn('searxng fallback threw; returning core result', {
        error: String(err),
        signals: fired,
      });
      return {
        ok: true,
        data: { ...coreResult.data, fallback_signal: signalLabel },
      };
    }

    if (!searxngResult.ok) {
      log.warn('searxng fallback failed; returning core result', {
        error: searxngResult.error,
        reason: searxngResult.error_reason,
        signals: fired,
      });
      return {
        ok: true,
        data: { ...coreResult.data, fallback_signal: signalLabel },
      };
    }

    const merged = mergeResults(coreResult.data, searxngResult.data, {
      maxResults: input.max_results,
    });

    const totalTime = Math.max(
      coreResult.data.total_time_ms,
      searxngResult.data.total_time_ms,
    );

    const data: SearchOutput = {
      ...coreResult.data,
      results: merged.results,
      engines_used: merged.engines_used,
      total_time_ms: totalTime,
      fallback_signal: signalLabel,
    };

    if (merged.engine_outcomes) {
      data.engine_outcomes = merged.engine_outcomes;
    } else {
      delete data.engine_outcomes;
    }

    if (searxngResult.data.warning && !data.warning) {
      data.warning = searxngResult.data.warning;
    }

    return { ok: true, data };
  }
}
