import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WigoloClient, WigoloApiError } from '../src/index.js';
import { freePort, makeSeededDataDir, spawnServe, type SpawnedServe } from './serve-harness.js';
import { scrubWigoloEnv } from './helpers.js';

/**
 * End-to-end against a real spawned serve. The full tool matrix runs TWICE:
 * open mode and token mode (bearer required). Shared warmed data dir; ephemeral
 * ports.
 */

const dataDir = makeSeededDataDir();
const TOKEN = 'integration-token';

interface Mode {
  name: string;
  token?: string;
}

const modes: Mode[] = [{ name: 'open mode' }, { name: 'token mode', token: TOKEN }];

for (const mode of modes) {
  describe(`tool matrix — ${mode.name}`, () => {
    let serve: SpawnedServe;
    let client: WigoloClient;

    beforeAll(async () => {
      scrubWigoloEnv();
      const port = await freePort();
      serve = await spawnServe({ port, dataDir, token: mode.token });
      const opts = mode.token
        ? { baseUrl: serve.baseUrl, token: mode.token }
        : { baseUrl: serve.baseUrl };
      client = new WigoloClient(opts);
    }, 90_000);

    afterAll(async () => {
      await serve?.stop();
    });

    it('health()', async () => {
      const h = await client.health();
      expect(typeof h.status).toBe('string');
    });

    it('search', async () => {
      const res = await client.search({ query: 'wigolo test', max_results: 3 });
      expect(res).toBeTypeOf('object');
      expect('results' in res || 'error' in res || 'warning' in res).toBe(true);
    });

    it('fetch', async () => {
      const res = await client.fetch({ url: 'https://example.com' });
      expect(res).toBeTypeOf('object');
      expect('markdown' in res || 'error' in res).toBe(true);
    });

    it('crawl map strategy returns urls and no pages', async () => {
      const res = await client.crawl({
        url: 'https://example.com',
        strategy: 'map',
        max_pages: 3,
      });
      expect(res.urls).toBeDefined();
      expect(res.pages).toBeUndefined();
    });

    it('cache stats', async () => {
      const res = await client.cache({ stats: true });
      expect(res).toBeTypeOf('object');
      expect(res.stats).toBeDefined();
    });

    it('extract tables (offline html)', async () => {
      const res = await client.extract({
        html: '<table><tr><th>a</th></tr><tr><td>1</td></tr></table>',
        mode: 'tables',
      });
      expect(res).toBeTypeOf('object');
      expect(res.data).toBeDefined();
    });

    it('findSimilar (cache only)', async () => {
      const res = await client.findSimilar({ concept: 'web scraping', include_web: false });
      expect(res).toBeTypeOf('object');
      expect('results' in res || 'method' in res).toBe(true);
    });

    it('research quick', async () => {
      const res = await client.research({
        question: 'what is example.com',
        depth: 'quick',
        max_sources: 2,
      });
      expect(res).toBeTypeOf('object');
      expect('report' in res || 'brief' in res || 'sources' in res).toBe(true);
    });

    it('agent', async () => {
      const res = await client.agent({
        prompt: 'summarize',
        urls: ['https://example.com'],
        max_pages: 1,
        max_time_ms: 15000,
      });
      expect(res).toBeTypeOf('object');
      expect('result' in res || 'sources' in res || 'warning' in res).toBe(true);
    });

    it('diff summary', async () => {
      const res = await client.diff({
        old: { markdown: 'a' },
        new: { markdown: 'b' },
        output: 'summary',
      });
      expect(res.changed).toBe(true);
    });

    it('watch list', async () => {
      const res = await client.watch({ action: 'list' });
      expect(res).toBeTypeOf('object');
      expect(res.jobs).toBeDefined();
    });
  });
}

describe('negative — token mode without a client token', () => {
  let serve: SpawnedServe;

  beforeAll(async () => {
    scrubWigoloEnv();
    const port = await freePort();
    serve = await spawnServe({ port, dataDir, token: TOKEN });
  }, 90_000);

  afterAll(async () => {
    await serve?.stop();
  });

  it('rejects an unauthenticated call with a typed 401', async () => {
    const client = new WigoloClient({ baseUrl: serve.baseUrl });
    const err = (await client.search({ query: 'x' }).catch((e: unknown) => e)) as WigoloApiError;
    expect(err).toBeInstanceOf(WigoloApiError);
    expect(err.status).toBe(401);
  });
});

describe('negative — 429 under a concurrency cap of 1', () => {
  let serve: SpawnedServe;

  beforeAll(async () => {
    scrubWigoloEnv();
    const port = await freePort();
    serve = await spawnServe({
      port,
      dataDir,
      extraEnv: { WIGOLO_SERVE_MAX_CONCURRENCY: '1' },
    });
  }, 90_000);

  afterAll(async () => {
    await serve?.stop();
  });

  it('a second concurrent slow call gets a typed 429 with retryAfter=5', async () => {
    const client = new WigoloClient({ baseUrl: serve.baseUrl });
    // Two concurrent research calls saturate the single slot; one must 429.
    const a = client
      .research({ question: 'slow one', depth: 'standard', max_sources: 3 })
      .catch((e: unknown) => e);
    const b = client
      .research({ question: 'slow two', depth: 'standard', max_sources: 3 })
      .catch((e: unknown) => e);
    const results = await Promise.all([a, b]);
    const rejected = results.filter(
      (r): r is WigoloApiError => r instanceof WigoloApiError && r.status === 429,
    );
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0].retryAfter).toBe(5);
  });
});

describe('negative — 413 oversized body', () => {
  let serve: SpawnedServe;

  beforeAll(async () => {
    scrubWigoloEnv();
    const port = await freePort();
    serve = await spawnServe({ port, dataDir });
  }, 90_000);

  afterAll(async () => {
    await serve?.stop();
  });

  it('rejects a >1MiB body with a typed 413', async () => {
    const client = new WigoloClient({ baseUrl: serve.baseUrl });
    const huge = 'x'.repeat(1024 * 1024 + 1024);
    const err = (await client
      .search({ query: 'x', agent_context: huge })
      .catch((e: unknown) => e)) as WigoloApiError;
    expect(err).toBeInstanceOf(WigoloApiError);
    expect(err.status).toBe(413);
  });
});

describe('negative — 400 clamp violation', () => {
  let serve: SpawnedServe;

  beforeAll(async () => {
    scrubWigoloEnv();
    const port = await freePort();
    serve = await spawnServe({ port, dataDir });
  }, 90_000);

  afterAll(async () => {
    await serve?.stop();
  });

  it('rejects a query array of 11 strings with a typed 400', async () => {
    const client = new WigoloClient({ baseUrl: serve.baseUrl });
    const queries = Array.from({ length: 11 }, (_v, i) => `q${i}`);
    const err = (await client.search({ query: queries }).catch((e: unknown) => e)) as WigoloApiError;
    expect(err).toBeInstanceOf(WigoloApiError);
    expect(err.status).toBe(400);
  });
});
