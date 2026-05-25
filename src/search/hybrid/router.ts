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

export class HybridSearchProvider implements SearchProvider {
  readonly name = 'hybrid' as const;

  constructor(
    private readonly core: SearchProvider,
    private readonly searxng: SearchProvider,
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
