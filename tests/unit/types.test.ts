import { describe, it, expect } from 'vitest';
import type {
  FetchInput,
  FetchOutput,
  SearchInput,
  SearchOutput,
  SearchResultItem,
  RawSearchResult,
  CrawlInput,
  CrawlOutput,
  CrawlResultItem,
  LinkEdge,
} from '../../src/types.js';

describe('types', () => {
  it('FetchInput accepts minimal input', () => {
    const input: FetchInput = { url: 'https://example.com' };
    expect(input.url).toBe('https://example.com');
    expect(input.render_js).toBeUndefined();
  });

  it('FetchOutput has required fields', () => {
    const output: FetchOutput = {
      url: 'https://example.com',
      title: 'Example',
      markdown: '# Example',
      metadata: {},
      links: [],
      images: [],
      cached: false,
    };
    expect(output.title).toBe('Example');
  });
});

describe('search types', () => {
  it('SearchInput accepts minimal input', () => {
    const input: SearchInput = { query: 'typescript tutorial' };
    expect(input.query).toBe('typescript tutorial');
    expect(input.max_results).toBeUndefined();
    expect(input.include_content).toBeUndefined();
  });

  it('SearchOutput has required fields', () => {
    const output: SearchOutput = {
      results: [],
      query: 'test',
      engines_used: ['searxng'],
      total_time_ms: 150,
    };
    expect(output.results).toEqual([]);
    expect(output.engines_used).toContain('searxng');
  });

  it('SearchResultItem supports content and failure fields', () => {
    const item: SearchResultItem = {
      title: 'Example',
      url: 'https://example.com',
      snippet: 'An example page',
      relevance_score: 0.95,
      markdown_content: '# Example',
    };
    expect(item.fetch_failed).toBeUndefined();
    expect(item.content_truncated).toBeUndefined();
  });

  it('RawSearchResult has engine field', () => {
    const raw: RawSearchResult = {
      title: 'Result',
      url: 'https://example.com',
      snippet: 'Snippet',
      relevance_score: 0.8,
      engine: 'duckduckgo',
    };
    expect(raw.engine).toBe('duckduckgo');
  });
});

describe('crawl types', () => {
  it('CrawlInput accepts minimal input', () => {
    const input: CrawlInput = { url: 'https://docs.example.com' };
    expect(input.url).toBe('https://docs.example.com');
    expect(input.max_depth).toBeUndefined();
    expect(input.strategy).toBeUndefined();
  });

  it('CrawlInput accepts all options', () => {
    const input: CrawlInput = {
      url: 'https://docs.example.com',
      max_depth: 3,
      max_pages: 50,
      strategy: 'sitemap',
      include_patterns: ['/docs/'],
      exclude_patterns: ['/blog/'],
      use_auth: true,
      extract_links: true,
      max_total_chars: 200000,
    };
    expect(input.strategy).toBe('sitemap');
    expect(input.include_patterns).toEqual(['/docs/']);
  });

  it('CrawlResultItem has required fields', () => {
    const item: CrawlResultItem = {
      url: 'https://docs.example.com/intro',
      title: 'Intro',
      markdown: '# Intro\n\nWelcome.',
      depth: 1,
    };
    expect(item.depth).toBe(1);
  });

  it('CrawlOutput has required fields', () => {
    const output: CrawlOutput = {
      pages: [],
      total_found: 10,
      crawled: 0,
    };
    expect(output.total_found).toBe(10);
    expect(output.links).toBeUndefined();
    expect(output.error).toBeUndefined();
  });

  it('LinkEdge represents a directed link', () => {
    const edge: LinkEdge = { from: 'https://a.com', to: 'https://a.com/page' };
    expect(edge.from).toBe('https://a.com');
  });
});

import type { BrowserAction, ActionResult } from '../../src/types.js';

describe('BrowserAction type — compile-time shape tests', () => {
  it('accepts a click action', () => {
    const action: BrowserAction = { type: 'click', selector: '.btn' };
    expect(action.type).toBe('click');
    expect(action.selector).toBe('.btn');
  });

  it('accepts a type action with selector and text', () => {
    const action: BrowserAction = { type: 'type', selector: '#email', text: 'test@example.com' };
    expect(action.type).toBe('type');
    expect(action.text).toBe('test@example.com');
  });

  it('accepts a wait action with ms', () => {
    const action: BrowserAction = { type: 'wait', ms: 1000 };
    expect(action.type).toBe('wait');
    expect(action.ms).toBe(1000);
  });

  it('accepts a wait_for action with selector and optional timeout', () => {
    const action: BrowserAction = { type: 'wait_for', selector: '.loaded', timeout: 5000 };
    expect(action.type).toBe('wait_for');
    expect(action.timeout).toBe(5000);
  });

  it('accepts a wait_for action without timeout', () => {
    const action: BrowserAction = { type: 'wait_for', selector: '.loaded' };
    expect(action.type).toBe('wait_for');
    expect(action.timeout).toBeUndefined();
  });

  it('accepts a scroll action with direction and optional amount', () => {
    const action: BrowserAction = { type: 'scroll', direction: 'down', amount: 500 };
    expect(action.type).toBe('scroll');
    expect(action.direction).toBe('down');
    expect(action.amount).toBe(500);
  });

  it('accepts a scroll action with direction only', () => {
    const action: BrowserAction = { type: 'scroll', direction: 'up' };
    expect(action.type).toBe('scroll');
    expect(action.amount).toBeUndefined();
  });

  it('accepts a screenshot action', () => {
    const action: BrowserAction = { type: 'screenshot' };
    expect(action.type).toBe('screenshot');
  });
});

describe('ActionResult type shape', () => {
  it('represents a successful action', () => {
    const result: ActionResult = { action_index: 0, type: 'click', success: true };
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('represents a failed action', () => {
    const result: ActionResult = {
      action_index: 1,
      type: 'wait_for',
      success: false,
      error: 'Timeout waiting for selector .missing',
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain('Timeout');
  });

  it('represents a screenshot action with data', () => {
    const result: ActionResult = {
      action_index: 2,
      type: 'screenshot',
      success: true,
      screenshot: 'base64encodeddata...',
    };
    expect(result.screenshot).toBeDefined();
  });
});

describe('FetchInput.actions field', () => {
  it('accepts undefined actions (backwards compatible)', () => {
    const input: FetchInput = { url: 'https://example.com' };
    expect(input.actions).toBeUndefined();
  });

  it('accepts an array of BrowserActions', () => {
    const input: FetchInput = {
      url: 'https://example.com',
      actions: [
        { type: 'wait_for', selector: '.cookie-banner', timeout: 3000 },
        { type: 'click', selector: '.cookie-banner .accept' },
        { type: 'wait', ms: 500 },
      ],
    };
    expect(input.actions).toHaveLength(3);
  });

  it('accepts an empty actions array', () => {
    const input: FetchInput = { url: 'https://example.com', actions: [] };
    expect(input.actions).toEqual([]);
  });
});

describe('FetchOutput.action_results field', () => {
  it('is optional (backwards compatible)', () => {
    const output: FetchOutput = {
      url: 'https://example.com',
      title: 'Test',
      markdown: '# Test',
      metadata: {},
      links: [],
      images: [],
      cached: false,
    };
    expect(output.action_results).toBeUndefined();
  });

  it('accepts an array of ActionResults', () => {
    const output: FetchOutput = {
      url: 'https://example.com',
      title: 'Test',
      markdown: '# Test',
      metadata: {},
      links: [],
      images: [],
      cached: false,
      action_results: [
        { action_index: 0, type: 'click', success: true },
        { action_index: 1, type: 'screenshot', success: true, screenshot: 'base64...' },
      ],
    };
    expect(output.action_results).toHaveLength(2);
  });
});
