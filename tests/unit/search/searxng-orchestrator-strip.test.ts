import { describe, it, expect } from 'vitest';
import type { SearchInput, SearchResultItem } from '../../../src/types.js';
import { stripMarkdownBodiesForAnswerMode } from '../../../src/search/legacy/searxng-orchestrator.js';

// H2: stripMarkdownBodiesForAnswerMode drops per-result markdown_content when
// the caller asked for synthesis (format='answer'/'stream_answer') and did NOT
// opt into include_full_markdown. The function is invoked from 4 separate
// branches in the legacy orchestrator (cache-replay, multi-query, single-query
// fast-path, single-query slow-path). A regression in any of those branches —
// adding a 5th path without the strip, or removing one of the existing strip
// calls — would silently 3× the answer-mode payload cost. This unit test pins
// the contract directly on the strip function so the integration surface
// stays honest even when only one path runs in CI.

function makeResult(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    title: 'r',
    url: 'https://example.com/r',
    snippet: 's',
    relevance_score: 0.5,
    markdown_content: '# heavy body text\n\n' + 'word '.repeat(500),
    ...overrides,
  };
}

describe('stripMarkdownBodiesForAnswerMode', () => {
  it("format='answer' + include_full_markdown unset → drops markdown_content, leaves citations + title intact", () => {
    const results: SearchResultItem[] = [
      makeResult({ title: 'a', url: 'https://example.com/a' }),
      makeResult({ title: 'b', url: 'https://example.com/b' }),
    ];
    const input: SearchInput = { query: 'q', format: 'answer' };

    stripMarkdownBodiesForAnswerMode(input, results);

    expect(results[0].markdown_content).toBeUndefined();
    expect(results[1].markdown_content).toBeUndefined();
    // Thin citation surface preserved — the strip only touches markdown_content.
    expect(results[0].title).toBe('a');
    expect(results[0].url).toBe('https://example.com/a');
    expect(results[0].snippet).toBe('s');
    expect(results[1].title).toBe('b');
  });

  it("format='answer' + include_full_markdown=true → preserves markdown_content (escape hatch)", () => {
    const original = '# preserved body\n\nimportant detail';
    const results: SearchResultItem[] = [makeResult({ markdown_content: original })];
    const input: SearchInput = { query: 'q', format: 'answer', include_full_markdown: true };

    stripMarkdownBodiesForAnswerMode(input, results);

    expect(results[0].markdown_content).toBe(original);
  });

  it("format=undefined (default 'evidence' mode) → preserves markdown_content", () => {
    // Defensive: even if a future code path calls the strip function outside
    // an answer-mode branch, evidence-mode payloads MUST keep their markdown.
    const original = '# evidence body kept';
    const results: SearchResultItem[] = [makeResult({ markdown_content: original })];
    const input: SearchInput = { query: 'q' }; // no format set

    stripMarkdownBodiesForAnswerMode(input, results);

    expect(results[0].markdown_content).toBe(original);
  });
});
