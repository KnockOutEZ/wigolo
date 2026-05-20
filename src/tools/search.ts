import type {
  SearchInput,
  SearchOutput,
  SearchEngine,
  ProgressCallback,
  StageResult,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';
import type { SamplingCapableServer } from '../search/sampling.js';
import { getSearchProvider } from '../providers/search-provider.js';

/**
 * Thin handler — validates wiring args and delegates to the selected search
 * provider (legacy SearXNG by default, V1 stub when `WIGOLO_SEARCH=v1`).
 *
 * All orchestration logic lives in `src/search/legacy/searxng-orchestrator.ts`.
 */
export async function handleSearch(
  input: SearchInput,
  engines: SearchEngine[],
  router: SmartRouter,
  backendStatus?: BackendStatus,
  samplingServer?: SamplingCapableServer,
  onProgress?: ProgressCallback,
): Promise<StageResult<SearchOutput>> {
  const provider = await getSearchProvider();
  return provider.search(input, {
    engines,
    router,
    backendStatus,
    samplingServer,
    onProgress,
  });
}
