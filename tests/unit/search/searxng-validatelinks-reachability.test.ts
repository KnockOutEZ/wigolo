import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

// Reachability (not a bare-function test): prove the legacy searxng orchestrator actually routes
// through validateLinks (orchestrator.ts:303/:527), so the R1 SSRF guard inside it is not dead code.
// validateLinks is spied as a passthrough; the heavy/irrelevant pipeline deps are stubbed so the
// drive is deterministic and reaches the validateLinks call.
const validateLinksSpy = vi.fn(async (r: unknown[]) => r);
vi.mock('../../../src/search/validator.js', () => ({ validateLinks: (r: unknown[]) => validateLinksSpy(r) }));
vi.mock('../../../src/search/rerank.js', () => ({ rerankResults: vi.fn(async (_q: string, r: unknown[]) => r) }));
vi.mock('../../../src/search/content-fetch.js', () => ({ fetchContentForResults: vi.fn(async () => {}) }));
vi.mock('../../../src/cache/store.js', () => ({ getCachedSearchResults: vi.fn(() => null), cacheSearchResults: vi.fn() }));

import { runSearxngSearch } from '../../../src/search/legacy/searxng-orchestrator.js';
import { resetConfig } from '../../../src/config.js';

const originalEnv = process.env;
beforeEach(() => { process.env = { ...originalEnv, VALIDATE_LINKS: 'true' }; resetConfig(); });
afterEach(() => { vi.clearAllMocks(); process.env = originalEnv; resetConfig(); });

function fakeEngine(results: RawSearchResult[]): SearchEngine {
  return { name: 'fake', search: vi.fn(async () => results) };
}
function fakeRouter(): SmartRouter {
  return { fetch: vi.fn(async () => ({ url: '', finalUrl: '', html: '', contentType: 'text/html', statusCode: 200, method: 'http' as const, headers: {} })) } as unknown as SmartRouter;
}

describe('legacy searxng orchestrator — reaches the guarded validateLinks', () => {
  it('runSearxngSearch routes its merged results through validateLinks (mode != cache)', async () => {
    const engine = fakeEngine([
      { title: 'Public', url: 'https://example.com/a', snippet: 'public result', relevance_score: 0.9, engine: 'fake' },
      { title: 'Internal', url: 'http://10.0.0.5/admin', snippet: 'internal result', relevance_score: 0.8, engine: 'fake' },
    ]);
    await runSearxngSearch({ query: 'a deterministic test query' }, { engines: [engine], router: fakeRouter() });
    // The orchestrator's merge path hit validateLinks — the guard inside it (proven by the SSRF pins)
    // is therefore live on the search-provider path, not dead code.
    expect(validateLinksSpy).toHaveBeenCalled();
  });
});
