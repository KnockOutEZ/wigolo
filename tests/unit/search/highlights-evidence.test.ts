import { describe, it, expect, vi } from 'vitest';
import type { SearchResultItem } from '../../../src/types.js';

vi.mock('../../../src/search/flashrank.js', () => ({
  isFlashRankAvailable: vi.fn(async () => false),
  flashRankRerank: vi.fn(),
}));

const { extractHighlights, fallbackHighlights } = await import(
  '../../../src/search/highlights.js'
);

describe('Highlight carries section_heading and source_span', () => {
  const longParagraph =
    'This is a long substantive paragraph describing the topic in enough detail to clear the minimum-length threshold for passages. '.repeat(2);

  const results: SearchResultItem[] = [
    {
      title: 'Doc',
      url: 'https://example.com/doc',
      snippet: 'doc snippet',
      relevance_score: 0.9,
      markdown_content: `# Heading\n\n${longParagraph}\n`,
    },
  ];

  it('fallbackHighlights attaches section_heading and span end > start', () => {
    const hs = fallbackHighlights(results, 5);
    expect(hs).toHaveLength(1);
    expect(hs[0].section_heading).toBe('Heading');
    expect(hs[0].source_span).toBeDefined();
    expect(hs[0].source_span!.end).toBeGreaterThan(hs[0].source_span!.start);
  });

  it('extractHighlights (no flashrank) attaches section_heading and span', async () => {
    const { highlights } = await extractHighlights('topic', results, 5);
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0].section_heading).toBe('Heading');
    expect(highlights[0].source_span).toBeDefined();
    expect(highlights[0].source_span!.end).toBeGreaterThan(highlights[0].source_span!.start);
  });
});
