import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchInput,
  SearchOutput,
  SearchResultItem,
  Citation,
  Highlight,
} from '../../../src/types.js';

vi.mock('../../../src/search/highlights.js', () => ({
  extractHighlights: vi.fn(),
}));

import { extractHighlights } from '../../../src/search/highlights.js';
import {
  applyEvidenceDefault,
  buildCitationsFromEvidence,
  stableCitationId,
} from '../../../src/search/evidence.js';

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
    text: 'A passage of text long enough to survive truncation.',
    source_index: 1,
    relevance_score: 0.7,
    source_url: 'https://example.com/a',
    source_title: 'T',
    section_heading: null,
    source_span: { start: 0, end: 50 },
    ...over,
  };
}

describe('applyEvidenceDefault', () => {
  beforeEach(() => {
    mockedExtract.mockReset();
  });

  it('zero results → no evidence, no citations, no warning', async () => {
    const output = makeOutput([]);
    const input: SearchInput = { query: 'q' };
    await applyEvidenceDefault(input, output, [], 'q');
    expect(output.evidence).toBeUndefined();
    expect(output.citations).toBeUndefined();
    expect(output.warning).toBeUndefined();
    expect(mockedExtract).not.toHaveBeenCalled();
  });

  it('extractHighlights rejects → warning surfaces, no crash', async () => {
    mockedExtract.mockRejectedValueOnce(new Error('boom'));
    const results = [makeResult()];
    const output = makeOutput(results);
    const input: SearchInput = { query: 'q' };
    await applyEvidenceDefault(input, output, results, 'q');
    expect(output.warning).toBe(
      'evidence extraction failed; results returned without highlights',
    );
    expect(output.evidence).toBeUndefined();
  });

  it('appends to existing warning rather than overwriting', async () => {
    mockedExtract.mockRejectedValueOnce(new Error('boom'));
    const results = [makeResult()];
    const output = makeOutput(results);
    output.warning = 'prior warning';
    const input: SearchInput = { query: 'q' };
    await applyEvidenceDefault(input, output, results, 'q');
    expect(output.warning).toBe(
      'prior warning; evidence extraction failed; results returned without highlights',
    );
  });

  it('max_tokens_out=0 → no evidence emitted, no crash', async () => {
    mockedExtract.mockResolvedValueOnce({
      highlights: [makeHighlight()],
      citations: [
        { index: 1, url: 'https://example.com/a', title: 'T', snippet: 'snippet text' },
      ],
      reranker_used: false,
    });
    const results = [makeResult()];
    const output = makeOutput(results);
    const input: SearchInput = { query: 'q', max_tokens_out: 0 };
    await applyEvidenceDefault(input, output, results, 'q');
    expect(output.evidence).toBeUndefined();
  });

  it('strips markdown_content by default', async () => {
    mockedExtract.mockResolvedValueOnce({
      highlights: [],
      citations: [],
      reranker_used: false,
    });
    const results = [makeResult({ markdown_content: 'BIG MARKDOWN CONTENT' })];
    const output = makeOutput(results);
    const input: SearchInput = { query: 'q' };
    await applyEvidenceDefault(input, output, results, 'q');
    expect(results[0].markdown_content).toBeUndefined();
  });

  it('preserves markdown_content when include_full_markdown=true', async () => {
    mockedExtract.mockResolvedValueOnce({
      highlights: [],
      citations: [],
      reranker_used: false,
    });
    const results = [makeResult({ markdown_content: 'BIG MARKDOWN CONTENT' })];
    const output = makeOutput(results);
    const input: SearchInput = { query: 'q', include_full_markdown: true };
    await applyEvidenceDefault(input, output, results, 'q');
    expect(results[0].markdown_content).toBe('BIG MARKDOWN CONTENT');
  });
});

describe('buildCitationsFromEvidence', () => {
  it('source with surviving evidence → citation has matching citation_id', () => {
    const results: SearchResultItem[] = [
      { title: 'T1', url: 'https://example.com/a', snippet: 's1', relevance_score: 0.9 },
    ];
    const citationId = stableCitationId('https://example.com/a', 0);
    const evidence = [
      {
        title: 'T1',
        url: 'https://example.com/a',
        section_heading: null,
        excerpt: 'ex',
        score: 0.7,
        citation_id: citationId,
        source_span: { start: 0, end: 10 },
        trusted: false,
      },
    ];
    const baseCitations: Citation[] = [
      { index: 1, url: 'https://example.com/a', title: 'T1', snippet: 's1' },
    ];
    const out = buildCitationsFromEvidence(results, evidence, baseCitations);
    expect(out).toHaveLength(1);
    expect(out[0].citation_id).toBe(citationId);
  });

  it('source whose evidence was budget-cut → citation has no citation_id', () => {
    const results: SearchResultItem[] = [
      { title: 'T1', url: 'https://example.com/a', snippet: 's1', relevance_score: 0.9 },
      { title: 'T2', url: 'https://example.com/b', snippet: 's2', relevance_score: 0.8 },
    ];
    const evidence = [
      {
        title: 'T1',
        url: 'https://example.com/a',
        section_heading: null,
        excerpt: 'ex',
        score: 0.7,
        citation_id: stableCitationId('https://example.com/a', 0),
        source_span: { start: 0, end: 10 },
        trusted: false,
      },
    ];
    const baseCitations: Citation[] = [
      { index: 1, url: 'https://example.com/a', title: 'T1', snippet: 's1' },
      { index: 2, url: 'https://example.com/b', title: 'T2', snippet: 's2' },
    ];
    const out = buildCitationsFromEvidence(results, evidence, baseCitations);
    expect(out).toHaveLength(2);
    expect(out[0].citation_id).toBeDefined();
    expect(out[1].citation_id).toBeUndefined();
    expect('citation_id' in out[1]).toBe(false);
  });

  it('does not mutate the base citation objects (shallow-clone)', () => {
    const results: SearchResultItem[] = [
      { title: 'T1', url: 'https://example.com/a', snippet: 's1', relevance_score: 0.9 },
    ];
    const baseCitation: Citation = {
      index: 1,
      url: 'https://example.com/a',
      title: 'T1',
      snippet: 's1',
    };
    const evidence = [
      {
        title: 'T1',
        url: 'https://example.com/a',
        section_heading: null,
        excerpt: 'ex',
        score: 0.7,
        citation_id: stableCitationId('https://example.com/a', 0),
        source_span: { start: 0, end: 10 },
        trusted: false,
      },
    ];
    const out = buildCitationsFromEvidence(results, evidence, [baseCitation]);
    expect(baseCitation.citation_id).toBeUndefined();
    expect(out[0].citation_id).toBeDefined();
  });
});
