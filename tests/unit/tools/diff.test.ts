import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(),
  getCachedContentByHash: vi.fn(),
  isExpired: vi.fn(),
}));

// The store mock stubs out the database, so the version-read seam must be
// stubbed alongside it — an unmocked `versionByHash` reaches a real
// `getDatabase()` and turns every hash miss into `diff_failed`.
vi.mock('../../../src/cache/version-read.js', () => ({
  versionByHash: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleDiff } from '../../../src/tools/diff.js';
import type { CachedContent } from '../../../src/types.js';
import { getCachedContent, getCachedContentByHash, isExpired } from '../../../src/cache/store.js';
import { versionByHash } from '../../../src/cache/version-read.js';

function makeCached(overrides: Partial<CachedContent> = {}): CachedContent {
  return {
    id: 1,
    url: 'https://example.com/a',
    normalizedUrl: 'https://example.com/a',
    title: 'a',
    markdown: 'cached body\n',
    rawHtml: '',
    metadata: '{}',
    links: '[]',
    images: '[]',
    fetchMethod: 'http',
    extractorUsed: 'defuddle',
    contentHash: 'a'.repeat(64),
    fetchedAt: new Date().toISOString(),
    expiresAt: null,
    ...overrides,
  };
}

describe('handleDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(getCachedContentByHash).mockReturnValue(null);
    vi.mocked(versionByHash).mockReturnValue(null);
    vi.mocked(isExpired).mockReturnValue(false);
  });

  describe('input validation', () => {
    it('returns error when neither markdown nor url supplied on either side', async () => {
      const r = await handleDiff({ old: {}, new: {} });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('invalid_input');
        expect(r.error_reason).toMatch(/old.*markdown|markdown.*url/i);
      }
    });

    it('returns error when old/new are missing entirely', async () => {
      const r = await handleDiff({});
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('invalid_input');
      }
    });

    it('rejects invalid output mode', async () => {
      const r = await handleDiff({
        old: { markdown: 'a' },
        new: { markdown: 'b' },
        // @ts-expect-error — testing runtime rejection of bad enum
        output: 'bogus',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error_reason).toMatch(/output/i);
      }
    });
  });

  describe('markdown inputs', () => {
    it('reports changed=false for identical markdown', async () => {
      const r = await handleDiff({
        old: { markdown: '# Same\nsame body\n' },
        new: { markdown: '# Same\nsame body\n' },
        output: 'unified',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.changed).toBe(false);
        expect(r.data.summary).toEqual({
          added_lines: 0,
          removed_lines: 0,
          modified_lines: 0,
          total_changed_chars: 0,
        });
      }
    });

    // Why: the unified output must produce a usable git-style patch — that's
    // the entire reason callers pick this mode over `summary`.
    it('returns a unified diff string when output=unified', async () => {
      const r = await handleDiff({
        old: { markdown: 'one\ntwo\nthree\n' },
        new: { markdown: 'one\nTWO\nthree\n' },
        output: 'unified',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.changed).toBe(true);
        expect(r.data.unified_diff).toBeDefined();
        expect(r.data.unified_diff).toContain('-two');
        expect(r.data.unified_diff).toContain('+TWO');
        expect(r.data.hunks).toBeUndefined();
      }
    });

    it('returns structured hunks when output=hunks', async () => {
      const r = await handleDiff({
        old: { markdown: 'one\ntwo\nthree\n' },
        new: { markdown: 'one\nTWO\nthree\n' },
        output: 'hunks',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.changed).toBe(true);
        expect(Array.isArray(r.data.hunks)).toBe(true);
        expect(r.data.hunks!.length).toBeGreaterThan(0);
        expect(r.data.unified_diff).toBeUndefined();
        const allKnownTypes = r.data.hunks!.every(
          (h) => h.change_type === 'added' || h.change_type === 'removed' || h.change_type === 'modified',
        );
        expect(allKnownTypes).toBe(true);
      }
    });

    it('returns only summary when output=summary', async () => {
      const r = await handleDiff({
        old: { markdown: 'one\ntwo\n' },
        new: { markdown: 'one\nTWO\nthree\n' },
        output: 'summary',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.changed).toBe(true);
        expect(r.data.unified_diff).toBeUndefined();
        expect(r.data.hunks).toBeUndefined();
        expect(r.data.summary!.added_lines + r.data.summary!.modified_lines).toBeGreaterThan(0);
      }
    });

    // Tool-boundary regression — granularity='word' returns
    // word-scoped hunks (not line-grouped). Mirrors the engine-level word
    // test so the dispatch at the handler stays honest.
    it('returns word-scoped hunks when granularity=word', async () => {
      const oldMd = 'The quick brown fox jumps over the lazy dog.';
      const newMd = 'The quick brown CAT jumps over the lazy dog.';

      const wordR = await handleDiff({
        old: { markdown: oldMd },
        new: { markdown: newMd },
        output: 'hunks',
        granularity: 'word',
      });
      const lineR = await handleDiff({
        old: { markdown: oldMd },
        new: { markdown: newMd },
        output: 'hunks',
        granularity: 'line',
      });
      expect(wordR.ok).toBe(true);
      expect(lineR.ok).toBe(true);
      if (!wordR.ok || !lineR.ok) return;

      const wordChars = wordR.data.hunks!.reduce((acc, h) => acc + h.before.length, 0);
      const lineChars = lineR.data.hunks!.reduce((acc, h) => acc + h.before.length, 0);
      // Word granularity must produce strictly tighter hunks than line.
      expect(wordChars).toBeLessThan(lineChars);
    });

    it('walks H1/H2/H3 section boundaries when granularity=section', async () => {
      const oldMd = [
        '# Top',
        'unchanged top',
        '## A',
        'old A body',
        '### A.1',
        'old A.1 body',
        '## B',
        'unchanged B',
      ].join('\n');
      const newMd = [
        '# Top',
        'unchanged top',
        '## A',
        'new A body',
        '### A.1',
        'new A.1 body',
        '## B',
        'unchanged B',
      ].join('\n');

      const r = await handleDiff({
        old: { markdown: oldMd },
        new: { markdown: newMd },
        output: 'hunks',
        granularity: 'section',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const titles = r.data.hunks!.map((h) => h.section_title);
        expect(titles).toContain('A');
        expect(titles).toContain('A.1');
        // Top + B unchanged
        expect(titles).not.toContain('B');
      }
    });
  });

  describe('URL inputs resolving via cache', () => {
    it('reads cached markdown when old.url is supplied', async () => {
      vi.mocked(getCachedContent).mockImplementation((url: string) => {
        if (url === 'https://example.com/a') {
          return {
            id: 1,
            url,
            normalizedUrl: 'https://example.com/a',
            title: 'a',
            markdown: 'cached old body\n',
            rawHtml: '',
            metadata: '{}',
            links: '[]',
            images: '[]',
            fetchMethod: 'http',
            extractorUsed: 'defuddle',
            contentHash: 'abc',
            fetchedAt: new Date().toISOString(),
            expiresAt: null,
          };
        }
        return null;
      });
      vi.mocked(isExpired).mockReturnValue(false);

      const r = await handleDiff({
        old: { url: 'https://example.com/a' },
        new: { markdown: 'cached new body\n' },
        output: 'unified',
      });

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.changed).toBe(true);
        expect(r.data.unified_diff).toContain('-cached old body');
        expect(r.data.unified_diff).toContain('+cached new body');
      }
    });

    // Why: cache miss must produce a structured error — silent re-fetch from
    // network would surprise callers who explicitly chose URL form to avoid
    // hitting the network.
    it('returns cache_miss error when URL is not cached', async () => {
      vi.mocked(getCachedContent).mockReturnValue(null);
      const r = await handleDiff({
        old: { url: 'https://example.com/uncached' },
        new: { markdown: 'something\n' },
        output: 'unified',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('cache_miss');
        expect(r.error_reason).toContain('https://example.com/uncached');
      }
    });

    // Why: `normalizeUrl` -> `new URL(url)` throws on malformed input. Without
    // pre-validation that throw bubbles past the side-resolver and reaches the
    // top-level handler as an opaque crash instead of a structured envelope.
    // Callers must always see `{ ok: false, error: 'invalid_input', ... }` for
    // bad input rather than an unhandled exception.
    it('returns invalid_input envelope when old.url is malformed', async () => {
      const r = await handleDiff({
        old: { url: 'not-a-valid-url' },
        new: { markdown: 'whatever\n' },
        output: 'unified',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('invalid_input');
        expect(r.error_reason).toMatch(/old\.url/i);
        expect(r.error_reason).toContain('not-a-valid-url');
      }
      // `getCachedContent` must NOT be invoked when the URL is malformed —
      // the pre-validation gate has to stop it before normalizeUrl can throw.
      expect(getCachedContent).not.toHaveBeenCalled();
    });

    it('returns invalid_input envelope when new.url is malformed', async () => {
      const r = await handleDiff({
        old: { markdown: 'a\n' },
        new: { url: 'http://' },
        output: 'unified',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('invalid_input');
        expect(r.error_reason).toMatch(/new\.url/i);
      }
    });

    it('treats expired cache entries as a miss', async () => {
      vi.mocked(getCachedContent).mockReturnValue({
        id: 1,
        url: 'https://example.com/stale',
        normalizedUrl: 'https://example.com/stale',
        title: 's',
        markdown: 'stale\n',
        rawHtml: '',
        metadata: '{}',
        links: '[]',
        images: '[]',
        fetchMethod: 'http',
        extractorUsed: 'defuddle',
        contentHash: 'old',
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      vi.mocked(isExpired).mockReturnValue(true);
      const r = await handleDiff({
        old: { url: 'https://example.com/stale' },
        new: { markdown: 'something\n' },
        output: 'unified',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('cache_miss');
      }
    });
  });

  describe('content_hash input', () => {
    const HASH = 'b'.repeat(64);

    // Why: `old.content_hash` is advertised on the tool schema, the MCP
    // instructions and docs/tools.md. The workflow it promises — `fetch` a
    // page, keep the returned `content_hash`, later diff against that exact
    // body without knowing the URL or re-fetching — only exists if the handler
    // actually resolves it. Before this it fell through to "url is required".
    it('resolves old.content_hash from the cache', async () => {
      vi.mocked(getCachedContentByHash).mockImplementation((hash: string) =>
        hash === HASH ? makeCached({ markdown: 'hashed old body\n' }) : null,
      );

      const r = await handleDiff({
        old: { content_hash: HASH },
        new: { markdown: 'hashed new body\n' },
        output: 'unified',
      });

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.changed).toBe(true);
        expect(r.data.unified_diff).toContain('-hashed old body');
        expect(r.data.unified_diff).toContain('+hashed new body');
      }
      expect(getCachedContentByHash).toHaveBeenCalledWith(HASH);
      // A hash is not a URL — the URL lookup must not be consulted.
      expect(getCachedContent).not.toHaveBeenCalled();
    });

    // Why: a hash whose row was never cached (or has since been evicted) must
    // reuse the EXISTING structured `cache_miss` envelope, not a new error
    // class and not a silent network re-fetch.
    it('returns the structured cache_miss envelope when the hash is unknown', async () => {
      vi.mocked(getCachedContentByHash).mockReturnValue(null);

      const r = await handleDiff({
        old: { content_hash: HASH },
        new: { markdown: 'anything\n' },
        output: 'unified',
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('cache_miss');
        expect(r.error_reason).toContain(HASH);
        expect(r.stage).toBe('diff');
      }
    });

    it('treats an expired row reached by hash as a miss', async () => {
      vi.mocked(getCachedContentByHash).mockReturnValue(makeCached({ markdown: 'stale\n' }));
      vi.mocked(isExpired).mockReturnValue(true);

      const r = await handleDiff({
        old: { content_hash: HASH },
        new: { markdown: 'anything\n' },
      });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('cache_miss');
    });

    // Why: the version table is not TTL'd, so consulting it after a TTL refusal
    // about the SAME bytes would let a caller read around the refusal the cache
    // just made. History is reached only when no live row carries the hash at
    // all — the ordinary state once a page has changed.
    it('does not consult retained versions when a live row carries the hash but is expired', async () => {
      vi.mocked(getCachedContentByHash).mockReturnValue(makeCached({ markdown: 'stale\n' }));
      vi.mocked(isExpired).mockReturnValue(true);
      vi.mocked(versionByHash).mockReturnValue({
        normalizedUrl: 'https://example.com/a',
        contentHash: HASH,
        markdown: 'retained body\n',
        title: null,
        httpStatus: 200,
        observedAt: '2026-08-18 00:00:00',
        byteLen: 14,
      });

      const r = await handleDiff({ old: { content_hash: HASH }, new: { markdown: 'anything\n' } });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('cache_miss');
      expect(versionByHash).not.toHaveBeenCalled();
    });

    // Why: the live row is the cheaper lookup and the authoritative current
    // body. History exists for hashes the live table can no longer answer.
    it('does not consult retained versions when a live row resolves the hash', async () => {
      vi.mocked(getCachedContentByHash).mockReturnValue(makeCached({ markdown: 'live body\n' }));

      const r = await handleDiff({ old: { content_hash: HASH }, new: { markdown: 'anything\n' } });

      expect(r.ok).toBe(true);
      expect(versionByHash).not.toHaveBeenCalled();
    });

    // Why: markdown is the caller's explicit content, so it must win over a
    // lookup even when both are supplied — otherwise a stray hash silently
    // replaces the body the caller handed us.
    it('prefers explicit markdown over content_hash', async () => {
      vi.mocked(getCachedContentByHash).mockReturnValue(makeCached({ markdown: 'from cache\n' }));

      const r = await handleDiff({
        old: { markdown: 'explicit old\n', content_hash: HASH },
        new: { markdown: 'explicit new\n' },
        output: 'unified',
      });

      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.unified_diff).toContain('-explicit old');
      expect(getCachedContentByHash).not.toHaveBeenCalled();
    });

    // Why: the schema, instructions and docs all scope content_hash to `old`.
    // Accepting it on `new` would make the handler more permissive than every
    // surface that documents it.
    it('does not accept content_hash on the new side', async () => {
      vi.mocked(getCachedContentByHash).mockReturnValue(makeCached({ markdown: 'from cache\n' }));

      const r = await handleDiff({
        old: { markdown: 'a\n' },
        new: { content_hash: HASH },
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('invalid_input');
        expect(r.error_reason).toMatch(/new\.markdown/);
        expect(r.error_reason).not.toMatch(/content_hash/);
      }
    });

    // Why: the "required" message is the only place a caller who supplied
    // nothing learns which keys the old side takes. Omitting content_hash
    // there is the same advertise-but-hide defect one layer down.
    it('names content_hash among the accepted old-side keys', async () => {
      const r = await handleDiff({ old: {}, new: { markdown: 'b\n' } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error_reason).toMatch(/old\.content_hash/);
    });
  });

  describe('store failures stay inside the envelope', () => {
    // Why: `resolveSide` used to run OUTSIDE handleDiff's try, so a SQLite-level
    // throw (locked/corrupt DB, disk full) escaped the tool's structured
    // envelope entirely — server.ts and the REST dispatch both call handleDiff
    // with no surrounding try, so it surfaced as an opaque crash.
    it('returns a structured envelope when the URL lookup throws', async () => {
      vi.mocked(getCachedContent).mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      });

      const r = await handleDiff({
        old: { url: 'https://example.com/a' },
        new: { markdown: 'b\n' },
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('diff_failed');
        expect(r.error_reason).toContain('SQLITE_BUSY');
        expect(r.stage).toBe('diff');
      }
    });

    it('returns a structured envelope when the hash lookup throws', async () => {
      vi.mocked(getCachedContentByHash).mockImplementation(() => {
        throw new Error('SQLITE_CORRUPT: database disk image is malformed');
      });

      const r = await handleDiff({
        old: { content_hash: 'c'.repeat(64) },
        new: { markdown: 'b\n' },
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('diff_failed');
        expect(r.error_reason).toContain('SQLITE_CORRUPT');
      }
    });
  });

  describe('size cap', () => {
    // Why: the spec mandates a `truncated: true` signal when the LCS cap is
    // hit, never a silent degrade. Without this, a 20k-line page would
    // produce a wrong-but-plausible "0 lines added" envelope.
    it('sets truncated:true and falls back to summary shape when over the line cap', async () => {
      const huge = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n');
      const huge2 = Array.from({ length: 6000 }, (_, i) => `line ${i} v2`).join('\n');
      const r = await handleDiff({
        old: { markdown: huge },
        new: { markdown: huge2 },
        output: 'unified',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.truncated).toBe(true);
        expect(r.data.changed).toBe(true);
        expect(r.data.summary).toBeDefined();
      }
    });

    // PR #89 sec+perf reviewers (HIGH): callers can pass markdown whose
    // token count blows past the safe LCS table size even when line count
    // is well under DIFF_LINE_CAP. The tool boundary MUST return a
    // structured envelope with `truncated:true`, never crash. This pins
    // the integration: input → handleDiff → envelope with truncation.
    it('returns truncated:true (never throws) for oversized word-granularity input', async () => {
      // ~60 tokens/line × 1000 lines = 60k tokens — over DIFF_TOKEN_CAP
      // (50k) yet well under DIFF_LINE_CAP (5000). Without the guard the
      // word-LCS path would attempt a 60k×60k Uint32Array (~14 GB).
      const tokensPerLine = 60;
      const tokenRow = Array.from({ length: tokensPerLine }, (_, i) => `t${i}`).join(' ');
      const oldLines: string[] = [];
      const newLines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        oldLines.push(`line${i} ${tokenRow}`);
        newLines.push(i === 500 ? `LINE${i} ${tokenRow}` : `line${i} ${tokenRow}`);
      }
      const r = await handleDiff({
        old: { markdown: oldLines.join('\n') },
        new: { markdown: newLines.join('\n') },
        output: 'hunks',
        granularity: 'word',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.truncated).toBe(true);
        expect(r.data.summary).toBeDefined();
      }
    });
  });
});
