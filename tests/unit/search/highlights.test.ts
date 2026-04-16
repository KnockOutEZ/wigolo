import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchResultItem } from '../../../src/types.js';

vi.mock('../../../src/search/flashrank.js', () => ({
  isFlashRankAvailable: vi.fn(),
  flashRankRerank: vi.fn(),
}));

const { isFlashRankAvailable, flashRankRerank } = await import('../../../src/search/flashrank.js');
const { extractHighlights, fallbackHighlights, splitIntoPassages } = await import(
  '../../../src/search/highlights.js'
);

const results: SearchResultItem[] = [
  {
    title: 'React Server Components',
    url: 'https://react.dev/rsc',
    snippet: 'RSC renders on the server.',
    relevance_score: 0.95,
    markdown_content: [
      '# React Server Components',
      '',
      'React Server Components render on the server before bundling and shipping to the client. This reduces bundle size and speeds first paint.',
      '',
      'They can fetch data directly from a database without an API layer.',
      '',
      '```',
      'const data = await db.query("...");',
      '```',
    ].join('\n'),
  },
  {
    title: 'Next.js Docs',
    url: 'https://nextjs.org/docs',
    snippet: 'Next.js uses RSC.',
    relevance_score: 0.88,
    markdown_content: [
      '## App Router',
      '',
      'Next.js App Router ships with React Server Components by default. Pages become server components unless marked with `"use client"`.',
      '',
      'Short.',
      '',
      'Another paragraph that describes streaming SSR and how chunks are flushed progressively as they render on the server.',
    ].join('\n'),
  },
];

describe('splitIntoPassages', () => {
  it('filters headings, table rows, code fences', () => {
    const md = '# Title\n\n| h | h |\n| --- |\n\n```\ncode\n```\n\nReal paragraph that is definitely longer than the minimum threshold for passages.';
    const parts = splitIntoPassages(md);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('Real paragraph');
  });

  it('drops short fragments below 50 chars', () => {
    const md = 'Short.\n\nAlso short too.\n\nAnd yet another short one that is clearly not long enough.';
    expect(splitIntoPassages(md)).toHaveLength(1);
  });

  it('caps long passages at 500 chars', () => {
    const md = 'x'.repeat(800);
    expect(splitIntoPassages(md)[0]).toHaveLength(500);
  });

  it('returns empty for empty input', () => {
    expect(splitIntoPassages('')).toEqual([]);
  });
});

describe('fallbackHighlights', () => {
  it('returns first substantive paragraph per source', () => {
    const highlights = fallbackHighlights(results, 10);
    expect(highlights).toHaveLength(2);
    expect(highlights[0].source_index).toBe(1);
    expect(highlights[0].text).toContain('render on the server');
    expect(highlights[1].source_index).toBe(2);
  });

  it('respects maxHighlights cap', () => {
    expect(fallbackHighlights(results, 1)).toHaveLength(1);
  });

  it('falls back to snippet when no passages qualify', () => {
    const sparse: SearchResultItem[] = [
      { title: 'T', url: 'u', snippet: 'only snippet available', relevance_score: 0.5 },
    ];
    const h = fallbackHighlights(sparse, 5);
    expect(h).toHaveLength(1);
    expect(h[0].text).toBe('only snippet available');
  });
});

describe('extractHighlights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses FlashRank when available and sorts passages by score', async () => {
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockImplementation(async (_q, passages) =>
      passages.map((p) => ({ index: p.index, score: 1 / (p.index + 1) })),
    );

    const out = await extractHighlights('server components', results, 3);

    expect(out.flashrank_used).toBe(true);
    expect(out.highlights.length).toBeGreaterThan(0);
    expect(out.highlights.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < out.highlights.length; i++) {
      expect(out.highlights[i - 1].relevance_score).toBeGreaterThanOrEqual(
        out.highlights[i].relevance_score,
      );
    }
    expect(out.citations).toHaveLength(2);
    expect(out.citations[0].index).toBe(1);
    expect(out.citations[0].url).toBe('https://react.dev/rsc');
  });

  it('falls back when FlashRank is unavailable', async () => {
    vi.mocked(isFlashRankAvailable).mockResolvedValue(false);

    const out = await extractHighlights('server components', results, 5);

    expect(out.flashrank_used).toBe(false);
    expect(out.highlights.length).toBeGreaterThan(0);
    expect(out.citations).toHaveLength(2);
  });

  it('falls back when FlashRank returns null', async () => {
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue(null);

    const out = await extractHighlights('x', results, 5);
    expect(out.flashrank_used).toBe(false);
    expect(out.highlights.length).toBeGreaterThan(0);
  });

  it('returns empty highlights array when no content', async () => {
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    const empty: SearchResultItem[] = [
      { title: 'No content', url: 'u', snippet: '', relevance_score: 0 },
    ];
    const out = await extractHighlights('q', empty, 10);
    expect(out.highlights).toEqual([]);
    expect(out.citations).toHaveLength(1);
  });

  it('source_index maps back to citations correctly', async () => {
    vi.mocked(isFlashRankAvailable).mockResolvedValue(false);
    const out = await extractHighlights('q', results, 10);
    for (const h of out.highlights) {
      const citation = out.citations.find((c) => c.index === h.source_index);
      expect(citation).toBeDefined();
      expect(citation!.url).toBe(h.source_url);
    }
  });
});
