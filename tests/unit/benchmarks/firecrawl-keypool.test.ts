import { describe, it, expect } from 'vitest';
import { KeyPool, firecrawlScrape, scoreMarkdown } from '../../../benchmarks/scrape-quality/firecrawl.js';
import type { Assertion } from '../../../benchmarks/scrape-quality/types.js';
import type { StructuredData } from '../../../src/types.js';

const EMPTY: StructuredData = { tables: [], definitions: [], jsonld: [], chart_hints: [], key_value_pairs: [] };

const ok = (markdown: string) => new Response(JSON.stringify({ success: true, data: { markdown } }), { status: 200 });
const status = (n: number) => new Response('{}', { status: n });

describe('KeyPool', () => {
  it('reads a comma-separated pool, falling back to the single-key var', () => {
    expect(KeyPool.fromEnv({ FIRECRAWL_API_KEYS: 'a,b,c' } as NodeJS.ProcessEnv).size).toBe(3);
    expect(KeyPool.fromEnv({ FIRECRAWL_API_KEY: 'solo' } as NodeJS.ProcessEnv).size).toBe(1);
    expect(KeyPool.fromEnv({} as NodeJS.ProcessEnv).size).toBe(0);
  });

  it('rotates the starting key between requests so one free-tier account is not drained first', () => {
    const pool = new KeyPool(['a', 'b', 'c']);
    const first = [...pool.candidates()].map((c) => c.key);
    const second = [...pool.candidates()].map((c) => c.key);
    expect(first[0]).toBe('a');
    expect(second[0]).toBe('b');
  });

  it('never yields a retired key again', () => {
    const pool = new KeyPool(['a', 'b']);
    pool.retire('a');
    expect([...pool.candidates()].map((c) => c.key)).toEqual(['b']);
    expect(pool.live).toBe(1);
  });
});

describe('firecrawlScrape', () => {
  it('fails over to the next account on 402 out-of-credits and succeeds there', async () => {
    const pool = new KeyPool(['dead', 'good']);
    const seen: string[] = [];
    const fake = (async (_u: string, init: RequestInit) => {
      const auth = String((init.headers as Record<string, string>).Authorization);
      seen.push(auth);
      return auth.includes('dead') ? status(402) : ok('real content');
    }) as unknown as typeof fetch;

    const r = await firecrawlScrape('https://x/', pool, fake);
    expect(r.ok).toBe(true);
    expect(r.markdown).toBe('real content');
    expect(seen).toHaveLength(2);
    // The exhausted account must be out of the pool for the rest of the run, or every
    // later request pays the same wasted round-trip.
    expect(pool.live).toBe(1);
  });

  it('also rotates on 429 throttling, not only on 402', async () => {
    const pool = new KeyPool(['throttled', 'good']);
    const fake = (async (_u: string, init: RequestInit) =>
      String((init.headers as Record<string, string>).Authorization).includes('throttled') ? status(429) : ok('body')
    ) as unknown as typeof fetch;
    expect((await firecrawlScrape('https://x/', pool, fake)).ok).toBe(true);
  });

  it('gives up with the last status once every account is exhausted, instead of looping', async () => {
    const pool = new KeyPool(['a', 'b']);
    const fake = (async () => status(402)) as unknown as typeof fetch;
    const r = await firecrawlScrape('https://x/', pool, fake);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(402);
    expect(pool.live).toBe(0);
  });

  it('does not retire an account over a non-quota error', async () => {
    // A 500 is Firecrawl's problem, not the account's — retiring would throw away a good key.
    const pool = new KeyPool(['a', 'b']);
    const fake = (async () => status(500)) as unknown as typeof fetch;
    const r = await firecrawlScrape('https://x/', pool, fake);
    expect(r.ok).toBe(false);
    expect(pool.live).toBe(2);
  });

  it('never puts a key value in the reported outcome', async () => {
    const pool = new KeyPool(['fc-supersecret']);
    const fake = (async () => ok('x')) as unknown as typeof fetch;
    const r = await firecrawlScrape('https://x/', pool, fake);
    expect(JSON.stringify(r)).not.toContain('supersecret');
    expect(r.keyLabel).toBe('key#1');
  });
});

describe('scoreMarkdown', () => {
  it('drops structured-shape assertions so Firecrawl is not scored on a capability it does not return', () => {
    // Firecrawl's scrape returns markdown only. Scoring `structured`/`table_cell` against it
    // would measure an absent format, not extraction quality.
    const assertions: Assertion[] = [
      { kind: 'contains', category: 'markdown_fidelity', value: 'hello', why: 't' },
      { kind: 'structured', category: 'structured_extract', field: 'tables', min: 3, why: 't' },
      { kind: 'table_cell', category: 'table_preservation', value: 'x', why: 't' },
    ];
    const s = scoreMarkdown(assertions, 'hello world', EMPTY);
    expect(s.total).toBe(1);
    expect(s.passed).toBe(1);
  });

  it('reports which assertions failed, so a head-to-head names the difference', () => {
    const assertions: Assertion[] = [
      { kind: 'absent', category: 'boilerplate_noise', value: 'Jump to content', why: 't' },
    ];
    const s = scoreMarkdown(assertions, 'Jump to content\nArticle', EMPTY);
    expect(s.passed).toBe(0);
    expect(s.failing).toEqual(['omits "Jump to content"']);
  });
});
