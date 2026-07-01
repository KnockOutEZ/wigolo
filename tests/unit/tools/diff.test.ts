import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(),
  isExpired: vi.fn(),
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
import { getCachedContent, isExpired } from '../../../src/cache/store.js';

describe('handleDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
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
