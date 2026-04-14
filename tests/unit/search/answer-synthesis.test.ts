import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  synthesizeAnswer,
  buildSynthesisPrompt,
  extractCitations,
  buildSourcesText,
} from '../../../src/search/answer-synthesis.js';
import type { SearchResultItem, Citation } from '../../../src/types.js';

function createMockServer(opts: {
  samplingSupported?: boolean;
  responseText?: string;
  samplingError?: Error;
} = {}) {
  return {
    getClientCapabilities: vi.fn().mockReturnValue(
      opts.samplingSupported !== false ? { sampling: {} } : {},
    ),
    createMessage: opts.samplingError
      ? vi.fn().mockRejectedValue(opts.samplingError)
      : vi.fn().mockResolvedValue({
          model: 'test-model',
          content: {
            type: 'text',
            text: opts.responseText ?? 'React Hooks allow you to use state in functional components [1]. They were introduced in React 16.8 [2].',
          },
        }),
  };
}

function makeResult(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    title: overrides.title ?? 'Test Title',
    url: overrides.url ?? 'https://example.com',
    snippet: overrides.snippet ?? 'A test snippet',
    relevance_score: overrides.relevance_score ?? 0.9,
    markdown_content: overrides.markdown_content,
    fetch_failed: overrides.fetch_failed,
    content_truncated: overrides.content_truncated,
  };
}

describe('buildSourcesText', () => {
  it('formats results as numbered sources with truncated content', () => {
    const results: SearchResultItem[] = [
      makeResult({
        title: 'React Hooks',
        url: 'https://react.dev/hooks',
        markdown_content: 'Hooks let you use state and other features.',
      }),
      makeResult({
        title: 'Vue Guide',
        url: 'https://vuejs.org/guide',
        markdown_content: 'The Composition API provides reactive features.',
      }),
    ];

    const text = buildSourcesText(results);

    expect(text).toContain('[1] React Hooks (https://react.dev/hooks)');
    expect(text).toContain('Hooks let you use state');
    expect(text).toContain('[2] Vue Guide (https://vuejs.org/guide)');
    expect(text).toContain('Composition API');
    expect(text).toContain('---');
  });

  it('skips results without content', () => {
    const results: SearchResultItem[] = [
      makeResult({
        title: 'No Content',
        url: 'https://no.com',
        markdown_content: undefined,
        snippet: '',
      }),
      makeResult({
        title: 'Has Content',
        url: 'https://has.com',
        markdown_content: 'Some useful content here.',
      }),
    ];

    const text = buildSourcesText(results);

    expect(text).not.toContain('[1] No Content');
    expect(text).toContain('[1] Has Content');
  });

  it('falls back to snippet when markdown_content is absent', () => {
    const results: SearchResultItem[] = [
      makeResult({
        title: 'Snippet Only',
        url: 'https://snippet.com',
        snippet: 'This is the fallback snippet text.',
        markdown_content: undefined,
      }),
    ];

    const text = buildSourcesText(results);

    expect(text).toContain('This is the fallback snippet text');
  });

  it('truncates content to 3000 chars per source', () => {
    const results: SearchResultItem[] = [
      makeResult({
        title: 'Long',
        url: 'https://long.com',
        markdown_content: 'x'.repeat(5000),
      }),
    ];

    const text = buildSourcesText(results);

    const sourceContent = text.split('\n\n---\n\n')[0];
    expect(sourceContent.length).toBeLessThan(3200);
  });

  it('returns empty string for empty results', () => {
    expect(buildSourcesText([])).toBe('');
  });

  it('returns empty string when all results lack content', () => {
    const results: SearchResultItem[] = [
      makeResult({ markdown_content: undefined, snippet: '' }),
      makeResult({ markdown_content: undefined, snippet: '' }),
    ];

    expect(buildSourcesText(results)).toBe('');
  });

  it('handles 5 results within token budget', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult({
        title: `Result ${i}`,
        url: `https://example.com/${i}`,
        markdown_content: `Content for result ${i} with some detail.`,
      }),
    );

    const text = buildSourcesText(results);

    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`[${i + 1}] Result ${i}`);
    }
  });
});

describe('buildSynthesisPrompt', () => {
  it('includes query and sources in the prompt', () => {
    const prompt = buildSynthesisPrompt('What are React hooks?', 'sources text here');

    expect(prompt).toContain('What are React hooks?');
    expect(prompt).toContain('sources text here');
  });

  it('includes citation instructions', () => {
    const prompt = buildSynthesisPrompt('test query', 'test sources');

    expect(prompt).toContain('[1]');
    expect(prompt.toLowerCase()).toContain('cit');
  });

  it('includes instruction to be concise', () => {
    const prompt = buildSynthesisPrompt('test', 'sources');

    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/concise|brief|direct|succinct/);
  });

  it('returns a non-empty string', () => {
    expect(buildSynthesisPrompt('q', 's').length).toBeGreaterThan(0);
  });
});

describe('extractCitations', () => {
  it('extracts citation indices from answer text', () => {
    const results: SearchResultItem[] = [
      makeResult({ title: 'React Hooks', url: 'https://react.dev/hooks', snippet: 'Hooks info' }),
      makeResult({ title: 'Vue Guide', url: 'https://vuejs.org/guide', snippet: 'Vue info' }),
      makeResult({ title: 'Svelte', url: 'https://svelte.dev', snippet: 'Svelte info' }),
    ];

    const answer = 'React Hooks are great [1]. Vue is also good [2]. But not [3].';
    const citations = extractCitations(answer, results);

    expect(citations).toHaveLength(3);
    expect(citations[0]).toEqual({
      index: 1,
      url: 'https://react.dev/hooks',
      title: 'React Hooks',
      snippet: 'Hooks info',
    });
    expect(citations[1]).toEqual({
      index: 2,
      url: 'https://vuejs.org/guide',
      title: 'Vue Guide',
      snippet: 'Vue info',
    });
  });

  it('returns empty array when no citations in text', () => {
    const results = [makeResult()];
    const citations = extractCitations('No citations here.', results);
    expect(citations).toEqual([]);
  });

  it('handles duplicate citation references', () => {
    const results = [
      makeResult({ title: 'A', url: 'https://a.com', snippet: 'A info' }),
    ];

    const answer = 'Mentioned [1] and again [1].';
    const citations = extractCitations(answer, results);

    expect(citations).toHaveLength(1);
    expect(citations[0].index).toBe(1);
  });

  it('ignores out-of-range citation indices', () => {
    const results = [
      makeResult({ title: 'Only', url: 'https://only.com', snippet: 'Only result' }),
    ];

    const answer = 'Valid [1] and invalid [5] reference.';
    const citations = extractCitations(answer, results);

    expect(citations).toHaveLength(1);
    expect(citations[0].index).toBe(1);
  });

  it('extracts citations with various formats', () => {
    const results = [
      makeResult({ title: 'A', url: 'https://a.com', snippet: 'A' }),
      makeResult({ title: 'B', url: 'https://b.com', snippet: 'B' }),
    ];

    const answer = 'See [1] and also [2].';
    const citations = extractCitations(answer, results);

    expect(citations).toHaveLength(2);
  });

  it('returns empty array for empty answer', () => {
    const results = [makeResult()];
    expect(extractCitations('', results)).toEqual([]);
  });

  it('returns empty array for empty results', () => {
    expect(extractCitations('text [1]', [])).toEqual([]);
  });

  it('handles results with missing snippet gracefully', () => {
    const results = [
      makeResult({ title: 'No Snippet', url: 'https://ns.com', snippet: '' }),
    ];

    const answer = 'Reference [1].';
    const citations = extractCitations(answer, results);

    expect(citations).toHaveLength(1);
    expect(citations[0].snippet).toBe('');
  });
});

describe('synthesizeAnswer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns synthesized answer when sampling is supported', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'React Hooks enable state in functional components [1].',
    });

    const results: SearchResultItem[] = [
      makeResult({
        title: 'React Hooks',
        url: 'https://react.dev/hooks',
        markdown_content: 'Hooks let you use state and other features.',
      }),
    ];

    const output = await synthesizeAnswer(results, 'What are React hooks?', server);

    expect(output.answer).toBe('React Hooks enable state in functional components [1].');
    expect(output.citations).toBeDefined();
    expect(output.citations!.length).toBeGreaterThanOrEqual(1);
    expect(output.fallback).toBe(false);
  });

  it('falls back when sampling is not supported', async () => {
    const server = createMockServer({ samplingSupported: false });

    const results: SearchResultItem[] = [
      makeResult({
        title: 'React Hooks',
        url: 'https://react.dev/hooks',
        markdown_content: 'Hooks content.',
      }),
    ];

    const output = await synthesizeAnswer(results, 'test', server);

    expect(output.answer).toBeUndefined();
    expect(output.fallback).toBe(true);
    expect(output.warning).toContain('sampling');
  });

  it('falls back when sampling request throws', async () => {
    const server = createMockServer({
      samplingSupported: true,
      samplingError: new Error('timeout'),
    });

    const results: SearchResultItem[] = [
      makeResult({ markdown_content: 'Content.' }),
    ];

    const output = await synthesizeAnswer(results, 'test', server);

    expect(output.fallback).toBe(true);
    expect(output.warning).toBeDefined();
  });

  it('falls back when no results have content', async () => {
    const server = createMockServer({ samplingSupported: true });

    const results: SearchResultItem[] = [
      makeResult({ markdown_content: undefined, snippet: '' }),
    ];

    const output = await synthesizeAnswer(results, 'test', server);

    expect(output.fallback).toBe(true);
    expect(output.warning).toContain('content');
  });

  it('falls back when results array is empty', async () => {
    const server = createMockServer({ samplingSupported: true });
    const output = await synthesizeAnswer([], 'test', server);

    expect(output.fallback).toBe(true);
  });

  it('returns citations matching the answer text', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'React introduced Hooks in 16.8 [1]. Vue has similar features [2].',
    });

    const results: SearchResultItem[] = [
      makeResult({
        title: 'React Hooks',
        url: 'https://react.dev/hooks',
        snippet: 'Hooks in React',
        markdown_content: 'Hooks were introduced in React 16.8.',
      }),
      makeResult({
        title: 'Vue Composition',
        url: 'https://vuejs.org/composition',
        snippet: 'Vue composition API',
        markdown_content: 'Vue 3 introduced the Composition API.',
      }),
    ];

    const output = await synthesizeAnswer(results, 'Compare React and Vue', server);

    expect(output.citations).toBeDefined();
    expect(output.citations!.length).toBe(2);
    expect(output.citations![0].url).toBe('https://react.dev/hooks');
    expect(output.citations![1].url).toBe('https://vuejs.org/composition');
  });

  it('handles empty sampling response text', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: '',
    });

    const results: SearchResultItem[] = [
      makeResult({ markdown_content: 'Content.' }),
    ];

    const output = await synthesizeAnswer(results, 'test', server);

    expect(output.fallback).toBe(true);
  });

  it('does not throw on malformed sampling response', async () => {
    const server = {
      getClientCapabilities: vi.fn().mockReturnValue({ sampling: {} }),
      createMessage: vi.fn().mockResolvedValue({ content: null }),
    };

    const results: SearchResultItem[] = [
      makeResult({ markdown_content: 'Content.' }),
    ];

    const output = await synthesizeAnswer(results, 'test', server);

    expect(output.fallback).toBe(true);
  });

  it('passes correct maxTokens to sampling', async () => {
    const server = createMockServer({ samplingSupported: true });

    const results: SearchResultItem[] = [
      makeResult({ markdown_content: 'Content.' }),
    ];

    await synthesizeAnswer(results, 'test', server);

    expect(server.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 1500 }),
    );
  });
});
