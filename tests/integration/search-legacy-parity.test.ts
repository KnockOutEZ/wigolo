/**
 * Legacy SearXNG parity guard.
 *
 * Confirms that `WIGOLO_SEARCH=searxng` (default) yields the same URL ordering
 * for a fixed query set as the pre-refactor implementation captured in
 * `fixtures/search-parity-snapshot.json`.
 *
 * Gated: requires a reachable SearXNG instance + a populated snapshot. The
 * sandbox/CI environment has neither, so the suite is conditionally skipped
 * unless `RUN_LEGACY_PARITY=1` is set. (Conditional `describe.skipIf` is
 * permitted — CLAUDE.md only bans hard `.skip` that hides broken behavior.)
 *
 * To run locally:
 *   RUN_LEGACY_PARITY=1 npx vitest run tests/integration/search-legacy-parity.test.ts
 *
 * Snapshot regeneration: deferred. Run the pre-refactor `runSearxngSearch`
 * against the same SearXNG instance and write { query, expectedUrls } pairs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSearchProvider,
  _resetSearchProviderForTest,
  type SearchContext,
} from '../../src/providers/search-provider.js';
import { _resetConfigForTest } from '../../src/config.js';
import type { SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';

const RUN = process.env.RUN_LEGACY_PARITY === '1';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath = join(here, 'fixtures', 'search-parity-snapshot.json');
const snapshot: { queries: { query: string; expectedUrls: string[] }[] } = JSON.parse(
  readFileSync(snapshotPath, 'utf8'),
);

describe.skipIf(!RUN)('legacy search parity', () => {
  let engines: SearchEngine[];
  let router: SmartRouter;

  beforeAll(async () => {
    // Real engines wired only when the gate is open. The router is never
    // invoked because `include_content: false` skips the fetch phase, so we
    // pass a guard proxy that throws on any access — keeps the parity test
    // focused on ranking, not content fetching.
    const { SearxngClient } = await import('../../src/search/searxng.js');
    const { getConfig } = await import('../../src/config.js');
    const url = getConfig().searxngUrl;
    if (!url) {
      throw new Error('SEARXNG_URL must be set when RUN_LEGACY_PARITY=1');
    }
    engines = [new SearxngClient(url)];
    router = new Proxy({} as SmartRouter, {
      get() {
        throw new Error('router should not be called when include_content=false');
      },
    });
  });

  it.each(snapshot.queries)(
    'returns identical URL ordering for: $query',
    async ({ query, expectedUrls }) => {
      process.env.WIGOLO_SEARCH = 'searxng';
      _resetSearchProviderForTest();
      _resetConfigForTest();
      const provider = await getSearchProvider();
      const ctx: SearchContext = { engines, router };
      const result = await provider.search(
        { query, max_results: 10, include_content: false },
        ctx,
      );
      if (!result.ok) {
        throw new Error(`search failed: ${result.error_reason ?? result.error}`);
      }
      expect(result.data.results.map(r => r.url).slice(0, 5)).toEqual(expectedUrls.slice(0, 5));
    },
  );
});
