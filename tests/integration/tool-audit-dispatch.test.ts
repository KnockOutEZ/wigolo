import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { createMcpServer, type Subsystems } from '../../src/server.js';
import type { StudioHostHandlers } from '../../src/daemon/studio-dispatch.js';

/**
 * D10 — the non-studio tool-invocation audit wrap, proven through the REAL CallTool dispatch
 * (createMcpServer → the single wrap at the request handler). The tool handlers are mocked to
 * fast trivial results so the test exercises the WRAP (coverage / privacy projection / isolation),
 * not the domain logic. Pairs with tests/unit/server/tool-audit.test.ts (leaf in isolation).
 */

// Mock every tool handler to a fast, trivial result. The wrap is handler-agnostic; what we assert
// is that exactly one audit row lands per non-studio call, with a privacy-projected args_meta.
vi.mock('../../src/tools/fetch.js', () => ({ handleFetch: vi.fn(async () => ({ ok: true, data: { markdown: '', url: 'https://x', title: '', metadata: {}, links: [], images: [], cached: false } })) }));
vi.mock('../../src/tools/search.js', () => ({ handleSearch: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock('../../src/tools/crawl.js', () => ({ handleCrawl: vi.fn(async () => ({ pages: [], total_found: 0, crawled: 0 })) }));
vi.mock('../../src/tools/cache.js', () => ({ handleCache: vi.fn(async () => ({ results: [] })) }));
vi.mock('../../src/tools/extract.js', () => ({ handleExtract: vi.fn(async () => ({ ok: true, data: { data: '' } })) }));
vi.mock('../../src/tools/find-similar.js', () => ({ handleFindSimilar: vi.fn(async () => ({ ok: true, data: { results: [] } })) }));
vi.mock('../../src/tools/research.js', () => ({ handleResearch: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock('../../src/tools/agent.js', () => ({ handleAgent: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock('../../src/tools/diff.js', () => ({ handleDiff: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock('../../src/tools/watch.js', () => ({ handleWatch: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock('../../src/server/search-response.js', () => ({ buildSearchContentBlocks: vi.fn(() => [{ type: 'text', text: '{}' }]) }));
vi.mock('../../src/watch/scheduler.js', () => ({ scheduleOverdueCheck: vi.fn() }));

import { handleFetch } from '../../src/tools/fetch.js';

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

const STUDIO_HOST: StudioHostHandlers = {
  observe: async () => ({ id: 's1', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (input) => ({ ok: true, action: input.action, url: input.url }),
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
};

function stubSubsystems(toolAuditDb: Database.Database | undefined, studioHost?: StudioHostHandlers): Subsystems {
  return {
    searchEngines: [],
    router: {},
    backendStatus: {},
    browserPool: {},
    pluginRegistry: {},
    shutdown: async () => {},
    bootstrapSearxng: async () => {},
    studioHost,
    toolAuditDb,
  } as unknown as Subsystems;
}

async function connect(subsystems: Subsystems): Promise<Client> {
  const server = createMcpServer(subsystems);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function rows(db: Database.Database): Array<{ tool: string; args_meta: string | null; outcome_ok: number; error_reason: string | null }> {
  return db.prepare('SELECT tool, args_meta, outcome_ok, error_reason FROM tool_audit ORDER BY id').all() as never;
}

const ALL_TEN = ['fetch', 'search', 'crawl', 'cache', 'extract', 'find_similar', 'research', 'agent', 'diff', 'watch'] as const;

describe('tool-audit wrap via real dispatch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('each of the ten tools produces EXACTLY ONE row on invocation (pin #5, ok path)', async () => {
    const db = migratedDb();
    const client = await connect(stubSubsystems(db));
    for (const tool of ALL_TEN) {
      await client.callTool({ name: tool, arguments: tool === 'fetch' ? { url: 'https://e.com/p' } : {} });
    }
    await client.close();
    const r = rows(db);
    expect(r).toHaveLength(10);
    expect(r.map((x) => x.tool).sort()).toEqual([...ALL_TEN].sort());
    expect(r.every((x) => x.outcome_ok === 1)).toBe(true);
    db.close();
  });

  it('an error outcome also produces exactly one row, with outcome_ok=0 and the typed reason (pin #5, error path)', async () => {
    const db = migratedDb();
    vi.mocked(handleFetch).mockResolvedValueOnce({ ok: false, error: 'boom', error_reason: 'fetch_failed', stage: 'fetch' } as never);
    const client = await connect(stubSubsystems(db));
    await client.callTool({ name: 'fetch', arguments: { url: 'https://e.com/p' } });
    await client.close();
    const r = rows(db);
    expect(r).toHaveLength(1);
    expect(r[0].tool).toBe('fetch');
    expect(r[0].outcome_ok).toBe(0);
    expect(r[0].error_reason).toBe('fetch_failed');
    db.close();
  });

  it('studio_* calls are EXCLUDED from the audit (they use studio_audit) (pin #3)', async () => {
    const db = migratedDb();
    const client = await connect(stubSubsystems(db, STUDIO_HOST));
    await client.callTool({ name: 'studio_observe', arguments: {} });
    await client.callTool({ name: 'studio_marks', arguments: {} });
    await client.callTool({ name: 'fetch', arguments: { url: 'https://e.com/p' } }); // a normal call DOES audit
    await client.close();
    const r = rows(db);
    expect(r.map((x) => x.tool)).toEqual(['fetch']); // no studio_* rows
    db.close();
  });

  it('a search call does NOT record the free-text query (pin #6)', async () => {
    const db = migratedDb();
    const client = await connect(stubSubsystems(db));
    await client.callTool({ name: 'search', arguments: { query: 'TOP-SECRET-INTENT', category: 'news' } });
    await client.close();
    const r = rows(db);
    expect(r).toHaveLength(1);
    expect(r[0].args_meta ?? '').not.toContain('TOP-SECRET-INTENT');
    expect(JSON.parse(r[0].args_meta!).category).toBe('news');
    db.close();
  });

  it('research/agent calls do NOT record the question/prompt (pin #6)', async () => {
    const db = migratedDb();
    const client = await connect(stubSubsystems(db));
    await client.callTool({ name: 'research', arguments: { question: 'SECRET-QUESTION', depth: 'quick' } });
    await client.callTool({ name: 'agent', arguments: { prompt: 'SECRET-PROMPT', max_pages: 2 } });
    await client.close();
    const r = rows(db);
    const joined = r.map((x) => x.args_meta ?? '').join('|');
    expect(joined).not.toContain('SECRET-QUESTION');
    expect(joined).not.toContain('SECRET-PROMPT');
    db.close();
  });

  it('a fetch URL is recorded with query+fragment STRIPPED (pin #7)', async () => {
    const db = migratedDb();
    const client = await connect(stubSubsystems(db));
    await client.callTool({ name: 'fetch', arguments: { url: 'https://example.com/page?token=abc123#frag' } });
    await client.close();
    const r = rows(db);
    expect(JSON.parse(r[0].args_meta!).url).toBe('https://example.com/page');
    expect(r[0].args_meta ?? '').not.toContain('token');
    db.close();
  });

  it('a throwing audit DB does NOT corrupt the tool result (pin #2, behavioral half)', async () => {
    const throwing = { prepare() { throw new Error('db torn down'); } } as unknown as Database.Database;
    const client = await connect(stubSubsystems(throwing));
    const res = (await client.callTool({ name: 'fetch', arguments: { url: 'https://e.com/p' } })) as { isError?: boolean; content: Array<{ text: string }> };
    await client.close();
    expect(res.isError).toBeFalsy(); // the fetch result is intact despite the audit-write failure
    expect(JSON.parse(res.content[0].text).url).toBe('https://x');
  });

  it('an undefined audit DB is a clean no-op — the tool still works (pin #2, uninit half)', async () => {
    const client = await connect(stubSubsystems(undefined));
    const res = (await client.callTool({ name: 'fetch', arguments: { url: 'https://e.com/p' } })) as { isError?: boolean };
    await client.close();
    expect(res.isError).toBeFalsy();
  });
});
