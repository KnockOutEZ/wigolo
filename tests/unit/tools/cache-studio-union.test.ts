import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { captureFromPage } from '../../../src/studio/capture/artifacts.js';
import { handleCache } from '../../../src/tools/cache.js';

/**
 * 4d slice-3 — surface studio_artifacts through the cache tool (FTS + hybrid).
 * This file's FTS-mode tests use a REAL db (no store mock) so the real
 * searchCacheFiltered + studio FTS run; hybrid tests (added at GREEN) mock only
 * the embed/vector providers.
 */

const CLIP_MD = 'Wigolo studio capture pipeline architecture and dedup notes — the knowledge moat layer.';
const QUERY = 'wigolo studio capture pipeline moat';

describe('cache tool — captured studio artifact via FTS (4d slice-3)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
  });

  it('surfaces a term-matching studio clip via the cache FTS path, hydrated', async () => {
    const capture = captureFromPage(
      { type: 'clip', sessionId: 'sess-c', url: 'https://x.example.com/p', title: 'Capture Notes', markdown: CLIP_MD },
      { db: getDatabase(), enqueue: () => undefined },
    );
    const studioKey = `studio://clip|${capture.id}`;

    const out = await handleCache({ query: QUERY });
    expect(out.error).toBeUndefined();
    const results = out.results ?? [];
    const hit = results.find((r) => r.url === studioKey);
    expect(
      hit,
      `expected a cache result for ${studioKey}; got ${JSON.stringify(results.map((r) => r.url))}`,
    ).toBeDefined();
    expect(hit!.markdown).toBe(CLIP_MD);
  });
});
