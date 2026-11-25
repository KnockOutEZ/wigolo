import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../../src/cache/db.js';
import { runSearxngSearch } from '../../../../src/search/legacy/searxng-orchestrator.js';
import type { SmartRouter } from '../../../../src/fetch/router.js';
import type { RawSearchResult, SearchEngine } from '../../../../src/types.js';

function engine(name: string, impl: () => Promise<RawSearchResult[]>): SearchEngine {
  return { name, search: impl } as SearchEngine;
}

const hit = (n: number): RawSearchResult => ({
  title: `Rust ownership guide ${n}`,
  url: `https://example${n}.com/rust-ownership`,
  snippet: 'Rust ownership and borrowing explained',
  relevance_score: 0.9 - n * 0.1,
  engine: 'bing',
});

const router = {} as SmartRouter;

// #685: when the configured search engine instance was down, pure searxng mode
// served the other engines' results with no hint that the instance failed.
describe('legacy search: instance failure is not silent', () => {
  let dir: string;
  const savedDataDir = process.env.WIGOLO_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-685-'));
    process.env.WIGOLO_DATA_DIR = dir;
    resetConfig();
    initDatabase(join(dir, 'wigolo.db'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    if (savedDataDir === undefined) delete process.env.WIGOLO_DATA_DIR;
    else process.env.WIGOLO_DATA_DIR = savedDataDir;
    resetConfig();
  });

  it.each([
    ['single query', 'rust ownership borrowing'],
    ['multi query', ['rust ownership', 'rust borrowing']],
  ] as const)('WHY: %s — warns with the reason when the instance errors', async (_label, query) => {
    const engines = [
      engine('searxng', async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8888'); }),
      engine('bing', async () => [hit(1), hit(2)]),
    ];
    const r = await runSearxngSearch(
      { query: query as string | string[], include_content: false, max_results: 2 },
      { engines, router },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.engines_used).not.toContain('searxng');
    expect(r.data.warning ?? '').toMatch(/search engine instance/i);
    expect(r.data.warning ?? '').toContain('ECONNREFUSED');
  });

  it('no warning when the instance answers', async () => {
    const engines = [
      engine('searxng', async () => [{ ...hit(1), engine: 'searxng' }]),
      engine('bing', async () => [hit(2)]),
    ];
    const r = await runSearxngSearch(
      { query: 'rust ownership borrowing', include_content: false, max_results: 2 },
      { engines, router },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.warning ?? '').not.toMatch(/search engine instance/i);
  });
});
