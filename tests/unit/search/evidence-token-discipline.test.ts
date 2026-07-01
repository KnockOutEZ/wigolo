import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchInput,
  SearchOutput,
  SearchResultItem,
  Highlight,
} from '../../../src/types.js';

vi.mock('../../../src/search/highlights.js', () => ({
  extractHighlights: vi.fn(),
}));

import { extractHighlights } from '../../../src/search/highlights.js';
import { applyEvidenceDefault } from '../../../src/search/evidence.js';

const mockedExtract = vi.mocked(extractHighlights);

function makeResult(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    title: 'T',
    url: 'https://example.com/a',
    snippet: 'snippet text',
    relevance_score: 0.9,
    markdown_content: '# Heading\n\nSome long content body for the source page.',
    ...overrides,
  };
}

function makeOutput(results: SearchResultItem[]): SearchOutput {
  return {
    results,
    query: 'q',
    engines_used: ['stub'],
    total_time_ms: 1,
  };
}

function makeHighlight(over: Partial<Highlight> = {}): Highlight {
  return {
    text: 'A passage of text long enough to survive truncation and be useful evidence content.',
    source_index: 1,
    relevance_score: 0.7,
    source_url: 'https://example.com/a',
    source_title: 'T',
    section_heading: null,
    source_span: { start: 0, end: 80 },
    ...over,
  };
}

// Evidence array must respect max_results.
describe('applyEvidenceDefault — H1 max_results cap', () => {
  beforeEach(() => {
    mockedExtract.mockReset();
  });

  it('caps evidence length at max_results when extractor returns more highlights', async () => {
    const highlights: Highlight[] = Array.from({ length: 10 }, (_, i) =>
      makeHighlight({
        text: `Passage ${i} long enough to survive truncation with enough words to count as a real excerpt.`,
        source_url: `https://example.com/${i}`,
        source_title: `T${i}`,
        relevance_score: 0.9 - i * 0.05,
        source_span: { start: i * 100, end: i * 100 + 80 },
      }),
    );
    mockedExtract.mockResolvedValueOnce({
      highlights,
      citations: [],
      reranker_used: false,
    });
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult({
        url: `https://example.com/${i}`,
        title: `T${i}`,
      }),
    );
    const output = makeOutput(results);
    const input: SearchInput = { query: 'q', max_results: 3 };
    await applyEvidenceDefault(input, output, results, 'q');
    expect(output.evidence).toBeDefined();
    expect(output.evidence!.length).toBeLessThanOrEqual(3);
  });

  it('returns all evidence when max_results is not set (no cap)', async () => {
    const highlights: Highlight[] = Array.from({ length: 4 }, (_, i) =>
      makeHighlight({
        text: `Passage ${i} long enough to survive truncation with enough words to count as a real excerpt.`,
        source_url: `https://example.com/${i}`,
        relevance_score: 0.9 - i * 0.05,
        source_span: { start: i * 100, end: i * 100 + 80 },
      }),
    );
    mockedExtract.mockResolvedValueOnce({
      highlights,
      citations: [],
      reranker_used: false,
    });
    const results = Array.from({ length: 4 }, (_, i) => makeResult({ url: `https://example.com/${i}` }));
    const output = makeOutput(results);
    const input: SearchInput = { query: 'q' };
    await applyEvidenceDefault(input, output, results, 'q');
    // Without max_results, all evidence items can flow (subject to token budget).
    expect(output.evidence).toBeDefined();
    expect(output.evidence!.length).toBeGreaterThan(1);
  });
});

// Evidence excerpts that are too short OR mostly link-markup should be dropped.
describe('applyEvidenceDefault — M18 link-fragment filter', () => {
  beforeEach(() => {
    mockedExtract.mockReset();
  });

  it('drops excerpts shorter than 40 chars', async () => {
    const highlights: Highlight[] = [
      makeHighlight({
        text: 'too short',
        source_url: 'https://example.com/1',
        source_span: { start: 0, end: 9 },
      }),
      makeHighlight({
        text: 'A passage of text long enough to survive the 40-char filter and be useful evidence content here.',
        source_url: 'https://example.com/2',
        source_span: { start: 0, end: 80 },
      }),
    ];
    mockedExtract.mockResolvedValueOnce({
      highlights,
      citations: [],
      reranker_used: false,
    });
    const results = [
      makeResult({ url: 'https://example.com/1' }),
      makeResult({ url: 'https://example.com/2' }),
    ];
    const output = makeOutput(results);
    const input: SearchInput = { query: 'q' };
    await applyEvidenceDefault(input, output, results, 'q');
    expect(output.evidence).toBeDefined();
    // The short excerpt should be filtered out — only the long one survives.
    for (const ev of output.evidence!) {
      expect(ev.excerpt.length).toBeGreaterThanOrEqual(40);
    }
    expect(output.evidence!.find((e) => e.url === 'https://example.com/1')).toBeUndefined();
    expect(output.evidence!.find((e) => e.url === 'https://example.com/2')).toBeDefined();
  });

  it('drops excerpts that are >50% link markup', async () => {
    // 50%+ of chars are inside markdown link constructs `[text](url)`.
    const linkHeavy =
      '[link1](https://a.com/1) [link2](https://b.com/2) [link3](https://c.com/3) hi';
    const cleanText =
      'A long, prose-rich passage about React Server Components and their performance characteristics described in detail.';
    const highlights: Highlight[] = [
      makeHighlight({
        text: linkHeavy,
        source_url: 'https://example.com/link',
        source_span: { start: 0, end: linkHeavy.length },
      }),
      makeHighlight({
        text: cleanText,
        source_url: 'https://example.com/clean',
        source_span: { start: 0, end: cleanText.length },
      }),
    ];
    mockedExtract.mockResolvedValueOnce({
      highlights,
      citations: [],
      reranker_used: false,
    });
    const results = [
      makeResult({ url: 'https://example.com/link' }),
      makeResult({ url: 'https://example.com/clean' }),
    ];
    const output = makeOutput(results);
    const input: SearchInput = { query: 'q' };
    await applyEvidenceDefault(input, output, results, 'q');
    expect(output.evidence).toBeDefined();
    expect(output.evidence!.find((e) => e.url === 'https://example.com/link')).toBeUndefined();
    expect(output.evidence!.find((e) => e.url === 'https://example.com/clean')).toBeDefined();
  });

  it('applies M18 filter BEFORE the max_results cap', async () => {
    // 5 highlights — 2 short/junk, 3 valid. With max_results=3, all 3 valid
    // ones should pass; the junk ones must not "consume" a slot.
    const highlights: Highlight[] = [
      makeHighlight({ text: 'short', source_url: 'https://example.com/short', source_span: { start: 0, end: 5 } }),
      makeHighlight({ text: '[a](u)', source_url: 'https://example.com/link', source_span: { start: 0, end: 6 } }),
      makeHighlight({
        text: 'A long passage of valid prose for source 1 with enough characters to pass the M18 filter.',
        source_url: 'https://example.com/1',
        source_span: { start: 0, end: 80 },
      }),
      makeHighlight({
        text: 'A long passage of valid prose for source 2 with enough characters to pass the M18 filter.',
        source_url: 'https://example.com/2',
        source_span: { start: 0, end: 80 },
      }),
      makeHighlight({
        text: 'A long passage of valid prose for source 3 with enough characters to pass the M18 filter.',
        source_url: 'https://example.com/3',
        source_span: { start: 0, end: 80 },
      }),
    ];
    mockedExtract.mockResolvedValueOnce({
      highlights,
      citations: [],
      reranker_used: false,
    });
    const results = [
      makeResult({ url: 'https://example.com/short' }),
      makeResult({ url: 'https://example.com/link' }),
      makeResult({ url: 'https://example.com/1' }),
      makeResult({ url: 'https://example.com/2' }),
      makeResult({ url: 'https://example.com/3' }),
    ];
    const output = makeOutput(results);
    const input: SearchInput = { query: 'q', max_results: 3 };
    await applyEvidenceDefault(input, output, results, 'q');
    expect(output.evidence).toBeDefined();
    // Exactly 3 valid evidence items survive — the M18 filter didn't waste slots.
    expect(output.evidence!.length).toBe(3);
    for (const ev of output.evidence!) {
      expect(ev.url).toMatch(/example\.com\/[123]$/);
    }
  });
});
