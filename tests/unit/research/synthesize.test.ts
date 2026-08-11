import { describe, it, expect, vi, beforeEach } from 'vitest';
import { synthesizeReport, buildFallbackReport } from '../../../src/research/synthesize.js';
import type { ResearchSource, Citation } from '../../../src/types.js';

function makeSource(overrides: Partial<ResearchSource> = {}): ResearchSource {
  return {
    url: overrides.url ?? 'https://example.com/article',
    title: overrides.title ?? 'Test Article',
    markdown_content: overrides.markdown_content ?? 'This is the article content about the topic.',
    relevance_score: overrides.relevance_score ?? 0.9,
    fetched: overrides.fetched ?? true,
    fetch_error: overrides.fetch_error,
    trusted: overrides.trusted ?? false,
  };
}

describe('synthesizeReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fallback synthesis (no server)', () => {
    it('produces a report from multiple sources', async () => {
      const sources: ResearchSource[] = [
        makeSource({ title: 'React Hooks Guide', url: 'https://react.dev/hooks', markdown_content: 'React Hooks allow function components to manage state.' }),
        makeSource({ title: 'Vue Composition API', url: 'https://vuejs.org/guide', markdown_content: 'Vue 3 introduces the Composition API for better code organization.' }),
      ];

      const result = await synthesizeReport(
        'Compare React and Vue state management',
        sources,
        'standard',
      );

      expect(result.report.length).toBeGreaterThan(0);
      expect(result.citations).toHaveLength(2);
      expect(result.samplingUsed).toBe(false);
    });

    it('includes citations with correct indices', async () => {
      const sources: ResearchSource[] = [
        makeSource({ title: 'Source A', url: 'https://a.com' }),
        makeSource({ title: 'Source B', url: 'https://b.com' }),
        makeSource({ title: 'Source C', url: 'https://c.com' }),
      ];

      const result = await synthesizeReport('test question', sources, 'standard');

      expect(result.citations[0].index).toBe(1);
      expect(result.citations[1].index).toBe(2);
      expect(result.citations[2].index).toBe(3);
      for (const citation of result.citations) {
        expect(citation.url).toBeTruthy();
        expect(citation.title).toBeTruthy();
      }
    });

    it('handles empty sources gracefully', async () => {
      const result = await synthesizeReport('test question', [], 'standard');

      expect(result.report).toContain('No sources');
      expect(result.citations).toHaveLength(0);
      expect(result.samplingUsed).toBe(false);
    });

    it('handles sources with fetch errors', async () => {
      const sources: ResearchSource[] = [
        makeSource({ fetched: false, fetch_error: 'timeout', markdown_content: '' }),
        makeSource({ title: 'Good Source', markdown_content: 'Valid content here.' }),
      ];

      const result = await synthesizeReport('test question', sources, 'standard');

      expect(result.report.length).toBeGreaterThan(0);
      expect(result.citations.length).toBeGreaterThanOrEqual(1);
    });

    it('truncates source content to token budget', async () => {
      const longContent = 'x'.repeat(10000);
      const sources: ResearchSource[] = [
        makeSource({ markdown_content: longContent }),
      ];

      const result = await synthesizeReport('test', sources, 'quick');

      expect(result.report.length).toBeGreaterThan(0);
      expect(result.report.length).toBeLessThan(longContent.length);
    });

    it('respects depth token limits for report length', async () => {
      const sources: ResearchSource[] = Array.from({ length: 10 }, (_, i) =>
        makeSource({
          title: `Source ${i}`,
          url: `https://example.com/${i}`,
          markdown_content: `Content for source ${i}. `.repeat(50),
        }),
      );

      const quickResult = await synthesizeReport('test', sources, 'quick');
      const standardResult = await synthesizeReport('test', sources, 'standard');
      const comprehensiveResult = await synthesizeReport('test', sources, 'comprehensive');

      expect(comprehensiveResult.report.length).toBeGreaterThanOrEqual(quickResult.report.length);
    });

    it('handles unicode content in sources', async () => {
      const sources: ResearchSource[] = [
        makeSource({ markdown_content: 'Die Zukunft der KI-Entwicklung im Jahr 2025.' }),
      ];

      const result = await synthesizeReport('KI-Trends', sources, 'quick');
      expect(result.report).toContain('KI');
    });
  });

  describe('sampling synthesis (with mock server)', () => {
    it('uses requestSampling when server is provided', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: {
            type: 'text',
            text: '## Research Report\n\nReact and Vue take different approaches to state management. React uses hooks [1] while Vue uses the Composition API [2].\n\n### Sources\n[1] https://react.dev\n[2] https://vuejs.org',
          },
        }),
      };

      const sources: ResearchSource[] = [
        makeSource({ title: 'React Hooks', url: 'https://react.dev', markdown_content: 'Hooks content' }),
        makeSource({ title: 'Vue Guide', url: 'https://vuejs.org', markdown_content: 'Vue content' }),
      ];

      const result = await synthesizeReport(
        'Compare React and Vue',
        sources,
        'standard',
        mockServer as any,
      );

      expect(result.samplingUsed).toBe(true);
      expect(result.report).toContain('Research Report');
      expect(mockServer.createMessage).toHaveBeenCalledTimes(1);
    });

    it('falls back when sampling fails', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockRejectedValue(new Error('sampling error')),
      };

      const sources: ResearchSource[] = [
        makeSource({ markdown_content: 'Some content' }),
      ];

      const result = await synthesizeReport('test', sources, 'standard', mockServer as any);

      expect(result.samplingUsed).toBe(false);
      expect(result.report.length).toBeGreaterThan(0);
    });

    it('falls back when sampling returns empty response', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: { type: 'text', text: '' },
        }),
      };

      const sources: ResearchSource[] = [
        makeSource({ markdown_content: 'Content here' }),
      ];

      const result = await synthesizeReport('test', sources, 'standard', mockServer as any);

      expect(result.samplingUsed).toBe(false);
      expect(result.report.length).toBeGreaterThan(0);
    });

    it('respects max token budget in sampling prompt', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: { type: 'text', text: 'A synthesized report.' },
        }),
      };

      const sources: ResearchSource[] = Array.from({ length: 20 }, (_, i) =>
        makeSource({
          title: `Source ${i}`,
          url: `https://example.com/${i}`,
          markdown_content: 'x'.repeat(5000),
        }),
      );

      await synthesizeReport('test', sources, 'comprehensive', mockServer as any);

      const call = mockServer.createMessage.mock.calls[0][0];
      const messageText = call.messages[0].content.text;
      expect(messageText.length).toBeLessThan(50000);
    });
  });
});

describe('buildFallbackReport', () => {
  it('produces formatted report with source blocks', () => {
    const sources: ResearchSource[] = [
      makeSource({ title: 'Source A', url: 'https://a.com', markdown_content: 'Content A here.' }),
      makeSource({ title: 'Source B', url: 'https://b.com', markdown_content: 'Content B here.' }),
    ];

    const report = buildFallbackReport('Test question', sources, 4000);

    expect(report).toContain('Test question');
    expect(report).toContain('Source A');
    expect(report).toContain('https://a.com');
    expect(report).toContain('Content A here');
    expect(report).toContain('Source B');
  });

  it('truncates to max length', () => {
    const sources: ResearchSource[] = [
      makeSource({ markdown_content: 'x'.repeat(10000) }),
    ];

    const report = buildFallbackReport('test', sources, 500);
    expect(report.length).toBeLessThanOrEqual(500);
  });

  // P4c — the keyless fallback report is what a caller without an LLM actually
  // reads, and it cut source bodies with a bare `.slice()`. On markdown that
  // ended paragraphs mid-word and left opening ``` fences with no closer, so
  // every renderer downstream treated the rest of the report as code.
  it('does not leave an unterminated code fence in the report', () => {
    const sources: ResearchSource[] = [
      makeSource({
        markdown_content:
          'Install the package first.\n\n```bash\n' +
          'wigolo search --max-results=50 --include-domains=example.com\n'.repeat(20) +
          '```\n\nThen run it.',
      }),
    ];

    const report = buildFallbackReport('test', sources, 600);

    expect(report.length).toBeLessThanOrEqual(600);
    expect((report.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('does not end a source body mid-word', () => {
    const body =
      'The reconciler compares the previous fiber tree against the next one and reuses whatever nodes it can, ' +
      'which keeps the commit phase proportional to the number of changed nodes rather than the size of the tree.';
    const sources: ResearchSource[] = [makeSource({ markdown_content: body })];

    const report = buildFallbackReport('test', sources, 260);

    expect(report.length).toBeLessThanOrEqual(260);

    // Pull out exactly the quoted source body: everything after the per-source
    // URL line, minus our own truncation marker.
    const m = report.match(/\*\*URL:\*\* [^\n]*\n\n([\s\S]*)$/);
    expect(m).not.toBeNull();
    const kept = (m as RegExpMatchArray)[1].replace(/\.\.\.$/, '').trimEnd();

    expect(kept.length).toBeGreaterThan(0);
    expect(body.startsWith(kept)).toBe(true);
    // The source character immediately after what we kept must be whitespace
    // (or end of input) — that is what "stopped at a word boundary" means.
    const next = body.slice(kept.length, kept.length + 1);
    expect(next === '' || /\s/.test(next)).toBe(true);
  });

  it('skips sources with no content', () => {
    const sources: ResearchSource[] = [
      makeSource({ title: 'Empty', markdown_content: '', fetched: false }),
      makeSource({ title: 'Good', markdown_content: 'Valid content.' }),
    ];

    const report = buildFallbackReport('test', sources, 5000);
    expect(report).not.toContain('Empty');
    expect(report).toContain('Good');
  });
});
