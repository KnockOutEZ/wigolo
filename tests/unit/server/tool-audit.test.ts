import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { projectToolArgs, recordToolCall } from '../../../src/server/tool-audit.js';

/**
 * D10 — non-studio tool-invocation audit (LEAF). The MCP CallTool handler records every
 * non-studio_* tool call into a NEW append-only `tool_audit` table for forensics. The leaf
 * holds two jobs: PRIVACY-AS-A-TYPE (project the call args through a CLOSED per-tool shape
 * that makes sensitive fields UNREPRESENTABLE — free-text intent omitted, target URLs stripped
 * of query+fragment), and a best-effort, non-throwing INSERT-only writer. Behavioral coverage
 * (one row per real dispatch) lives in tests/integration/tool-audit-dispatch.test.ts; this file
 * pins the projection + the writer in isolation.
 */

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

function rows(db: Database.Database): Array<{ tool: string; args_meta: string | null; outcome_ok: number; error_reason: string | null; duration_ms: number | null }> {
  return db.prepare('SELECT tool, args_meta, outcome_ok, error_reason, duration_ms FROM tool_audit ORDER BY id').all() as never;
}

describe('projectToolArgs — privacy-as-a-type projection (fail-closed)', () => {
  it('fetch: strips query+fragment from the URL and OMITS headers entirely (pin #7, #1-runtime)', () => {
    const meta = projectToolArgs('fetch', {
      url: 'https://example.com/secret/path?token=abc123&q=hi#frag',
      headers: { authorization: 'Bearer SECRET' },
      render_js: 'always',
      use_auth: true,
    }) as Record<string, unknown>;
    expect(meta.url).toBe('https://example.com/secret/path');
    expect(meta.render_js).toBe('always');
    expect(meta.use_auth).toBe(true);
    const json = JSON.stringify(meta);
    expect(json).not.toContain('token');
    expect(json).not.toContain('abc123');
    expect(json).not.toContain('frag');
    expect(json).not.toContain('authorization');
    expect(json).not.toContain('SECRET');
  });

  it('fetch: an unparseable URL is OMITTED (never logged raw — fail-closed)', () => {
    const meta = projectToolArgs('fetch', { url: 'not a url', render_js: 'auto' }) as Record<string, unknown>;
    expect(meta.url).toBeUndefined();
    expect(meta.render_js).toBe('auto');
  });

  it('search: OMITS the free-text query, keeps the structural flags (pin #6)', () => {
    const meta = projectToolArgs('search', {
      query: 'TOP-SECRET-RESEARCH-INTENT',
      category: 'news',
      time_range: 'week',
      search_depth: 'deep',
      exact_match: true,
      max_results: 7,
    }) as Record<string, unknown>;
    expect(JSON.stringify(meta)).not.toContain('TOP-SECRET-RESEARCH-INTENT');
    expect(meta.category).toBe('news');
    expect(meta.time_range).toBe('week');
    expect(meta.search_depth).toBe('deep');
    expect(meta.exact_match).toBe(true);
    expect(meta.max_results).toBe(7);
  });

  it('search: an array query is OMITTED too (pin #6)', () => {
    const meta = projectToolArgs('search', { query: ['leak-a', 'leak-b'], category: 'general' }) as Record<string, unknown>;
    const json = JSON.stringify(meta);
    expect(json).not.toContain('leak-a');
    expect(json).not.toContain('leak-b');
    expect(meta.category).toBe('general');
  });

  it('research: OMITS the free-text question (pin #6)', () => {
    const meta = projectToolArgs('research', { question: 'my-private-question', depth: 'quick', max_sources: 5 }) as Record<string, unknown>;
    expect(JSON.stringify(meta)).not.toContain('my-private-question');
    expect(meta.depth).toBe('quick');
    expect(meta.max_sources).toBe(5);
  });

  it('agent: OMITS the free-text prompt (pin #6)', () => {
    const meta = projectToolArgs('agent', { prompt: 'secret-agent-prompt', max_pages: 4, max_time_ms: 9000, urls: ['https://a.com', 'https://b.com'] }) as Record<string, unknown>;
    expect(JSON.stringify(meta)).not.toContain('secret-agent-prompt');
    expect(meta.max_pages).toBe(4);
    expect(meta.max_time_ms).toBe(9000);
    // raw target URLs are not logged verbatim; only a count is structural
    expect(meta.url_count).toBe(2);
    expect(JSON.stringify(meta)).not.toContain('a.com');
  });

  it('cache: OMITS query AND url_pattern (both free-text/locator) (pin #6)', () => {
    const meta = projectToolArgs('cache', { query: 'secret-q', url_pattern: 'secret-pattern', stats: true, mode: 'hybrid' }) as Record<string, unknown>;
    const json = JSON.stringify(meta);
    expect(json).not.toContain('secret-q');
    expect(json).not.toContain('secret-pattern');
    expect(meta.stats).toBe(true);
    expect(meta.mode).toBe('hybrid');
  });

  it('find_similar: OMITS the free-text concept, strips the seed URL (pin #6, #7)', () => {
    const meta = projectToolArgs('find_similar', { concept: 'private-concept', url: 'https://e.com/p?s=secret', mode: 'cache', max_results: 3 }) as Record<string, unknown>;
    const json = JSON.stringify(meta);
    expect(json).not.toContain('private-concept');
    expect(json).not.toContain('secret');
    expect(meta.url).toBe('https://e.com/p');
    expect(meta.mode).toBe('cache');
  });

  it('extract: keeps url(stripped)+mode, OMITS raw html and css_selector (fail-closed)', () => {
    const meta = projectToolArgs('extract', { url: 'https://e.com/x?k=secret', html: '<b>SECRETBODY</b>', css_selector: '.private-class', mode: 'tables' }) as Record<string, unknown>;
    const json = JSON.stringify(meta);
    expect(json).not.toContain('SECRETBODY');
    expect(json).not.toContain('private-class');
    expect(json).not.toContain('secret');
    expect(meta.url).toBe('https://e.com/x');
    expect(meta.mode).toBe('tables');
  });

  it('watch: keeps action/url(stripped), OMITS the notification webhook URL+token and the selector (fail-closed)', () => {
    const meta = projectToolArgs('watch', {
      action: 'create',
      url: 'https://e.com/watch?t=secret',
      notification: 'https://hooks.example.com/abc?token=WEBHOOKSECRET',
      selector: '.secret-selector',
      interval_seconds: 120,
    }) as Record<string, unknown>;
    const json = JSON.stringify(meta);
    expect(json).not.toContain('WEBHOOKSECRET');
    expect(json).not.toContain('hooks.example.com');
    expect(json).not.toContain('secret-selector');
    expect(meta.action).toBe('create');
    expect(meta.url).toBe('https://e.com/watch');
    expect(meta.interval_seconds).toBe(120);
  });

  it('crawl: strips the URL, keeps strategy/depth (pin #7)', () => {
    const meta = projectToolArgs('crawl', { url: 'https://e.com/docs?v=secret', strategy: 'bfs', max_depth: 2, max_pages: 10 }) as Record<string, unknown>;
    expect(meta.url).toBe('https://e.com/docs');
    expect(JSON.stringify(meta)).not.toContain('secret');
    expect(meta.strategy).toBe('bfs');
    expect(meta.max_depth).toBe(2);
  });

  it('diff: keeps only output/granularity (old/new may carry raw markdown — unrepresentable)', () => {
    const meta = projectToolArgs('diff', { old: { markdown: 'SECRET-OLD' }, new: { markdown: 'SECRET-NEW' }, output: 'summary', granularity: 'word' }) as Record<string, unknown>;
    const json = JSON.stringify(meta);
    expect(json).not.toContain('SECRET-OLD');
    expect(json).not.toContain('SECRET-NEW');
    expect(meta.output).toBe('summary');
    expect(meta.granularity).toBe('word');
  });

  it('an unknown tool projects to undefined (no shape assumed)', () => {
    expect(projectToolArgs('definitely_not_a_tool', { whatever: 1 })).toBeUndefined();
  });
});

describe('recordToolCall — INSERT-only, best-effort writer', () => {
  it('inserts one metadata row (tool/args_meta/outcome/error/duration)', () => {
    const db = migratedDb();
    recordToolCall(db, {
      tool: 'fetch',
      argsMeta: projectToolArgs('fetch', { url: 'https://e.com/p' }),
      outcomeOk: true,
      ts: 1234,
      durationMs: 42,
    });
    const r = rows(db);
    expect(r).toHaveLength(1);
    expect(r[0].tool).toBe('fetch');
    expect(r[0].outcome_ok).toBe(1);
    expect(r[0].duration_ms).toBe(42);
    expect(JSON.parse(r[0].args_meta!).url).toBe('https://e.com/p');
    db.close();
  });

  it('records an error outcome with its typed error_reason', () => {
    const db = migratedDb();
    recordToolCall(db, { tool: 'search', outcomeOk: false, errorReason: 'no_results', ts: 1, durationMs: 5 });
    const r = rows(db);
    expect(r[0].outcome_ok).toBe(0);
    expect(r[0].error_reason).toBe('no_results');
    db.close();
  });

  it('SWALLOWS a throwing DB handle — never propagates (pin #2, leaf half)', () => {
    const throwing = { prepare() { throw new Error('db torn down'); } };
    expect(() => recordToolCall(throwing, { tool: 'fetch', outcomeOk: true, ts: 1, durationMs: 1 })).not.toThrow();
  });

  it('an undefined DB handle is a silent no-op (never throws)', () => {
    expect(() => recordToolCall(undefined, { tool: 'fetch', outcomeOk: true, ts: 1, durationMs: 1 })).not.toThrow();
  });
});

// ---- Structural seam pins (source + import-graph; mutation-validated) ----

const SRC = resolve(fileURLToPath(new URL('../../../src', import.meta.url)));
const LEAF = join(SRC, 'server/tool-audit.ts');

describe('tool-audit leaf — structural invariants', () => {
  it('the leaf is INSERT-only — no UPDATE/DELETE/REPLACE statement against tool_audit (pin #4)', () => {
    const src = readFileSync(LEAF, 'utf8');
    // Table-qualified so the writer's own prose ("never UPDATE/DELETE") can't false-trip; a real
    // mutation adds `DELETE FROM tool_audit` / `UPDATE tool_audit` / `REPLACE INTO tool_audit` → REDS.
    expect(/UPDATE\s+tool_audit/i.test(src)).toBe(false);
    expect(/DELETE\s+FROM\s+tool_audit/i.test(src)).toBe(false);
    expect(/REPLACE\s+INTO\s+tool_audit|ON\s+CONFLICT/i.test(src)).toBe(false);
    expect(/INSERT\s+INTO\s+tool_audit/i.test(src)).toBe(true);
  });

  it('the leaf does NOT reach for the global DB — getDatabase is never named, db module never DIRECTLY imported (pin #8)', () => {
    const src = readFileSync(LEAF, 'utf8');
    // mutation: import/call getDatabase in the leaf → REDS (the handle MUST be injected).
    expect(src.includes('getDatabase')).toBe(false);
    // Direct-import check (NOT transitive closure: logger→config→…→db pulls db.ts in transitively,
    // which is unrelated to whether THIS leaf reaches for the global handle). mutation: add
    // `import { getDatabase } from '../cache/db.js'` → a direct cache/db specifier → REDS.
    const directImports = [...src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(directImports.some((s) => /cache\/db(\.js)?$/.test(s))).toBe(false);
  });
});
