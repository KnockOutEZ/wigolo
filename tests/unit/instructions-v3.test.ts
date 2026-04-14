import { describe, it, expect } from 'vitest';
import { WIGOLO_INSTRUCTIONS, TOOL_DESCRIPTIONS } from '../../src/instructions.js';
import type { ToolName } from '../../src/instructions.js';

describe('WIGOLO_INSTRUCTIONS v3 routing patterns', () => {
  it('mentions all v3 tools by name', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('find_similar');
    expect(WIGOLO_INSTRUCTIONS).toContain('research');
    expect(WIGOLO_INSTRUCTIONS).toContain('agent');
  });

  it('contains documentation lookup routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('include_domains');
    expect(WIGOLO_INSTRUCTIONS).toContain('docs');
  });

  it('contains error debugging routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toMatch(/error/i);
    expect(WIGOLO_INSTRUCTIONS).toContain('category');
  });

  it('contains library research routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('sitemap');
  });

  it('contains related content routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('find_similar');
  });

  it('contains direct answer routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('answer');
  });

  it('contains comprehensive research routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('research');
    expect(WIGOLO_INSTRUCTIONS).toContain('depth');
  });

  it('contains data gathering routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('agent');
    expect(WIGOLO_INSTRUCTIONS).toContain('schema');
  });

  it('contains cache-first guidance', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('cache');
    expect(WIGOLO_INSTRUCTIONS).toMatch(/before.*(search|fetch)/i);
  });

  it('contains multi-query guidance', () => {
    expect(WIGOLO_INSTRUCTIONS).toMatch(/multi.*query|array.*query|semantically.*varied/i);
  });

  it('mentions answer format for search', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('answer');
  });

  it('is a non-empty string of reasonable length', () => {
    expect(typeof WIGOLO_INSTRUCTIONS).toBe('string');
    expect(WIGOLO_INSTRUCTIONS.length).toBeGreaterThan(500);
    expect(WIGOLO_INSTRUCTIONS.length).toBeLessThan(10000);
  });

  it('does not contain implementation details or code samples', () => {
    expect(WIGOLO_INSTRUCTIONS).not.toContain('import ');
    expect(WIGOLO_INSTRUCTIONS).not.toContain('function ');
    expect(WIGOLO_INSTRUCTIONS).not.toContain('const ');
    expect(WIGOLO_INSTRUCTIONS).not.toContain('npm ');
  });

  it('uses backtick-quoted tool names consistently', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('`search`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`fetch`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`crawl`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`cache`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`extract`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`find_similar`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`research`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`agent`');
  });

  it('preserves existing v2 routing guidance', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('localhost');
    expect(WIGOLO_INSTRUCTIONS).toContain('use_auth');
    expect(WIGOLO_INSTRUCTIONS).toContain('FTS5');
    expect(WIGOLO_INSTRUCTIONS).toContain('sitemap');
    expect(WIGOLO_INSTRUCTIONS).toContain('include_patterns');
  });
});

describe('TOOL_DESCRIPTIONS v3 entries', () => {
  it('has all 8 tool descriptions', () => {
    const keys = Object.keys(TOOL_DESCRIPTIONS);
    expect(keys).toContain('fetch');
    expect(keys).toContain('search');
    expect(keys).toContain('crawl');
    expect(keys).toContain('cache');
    expect(keys).toContain('extract');
    expect(keys).toContain('find_similar');
    expect(keys).toContain('research');
    expect(keys).toContain('agent');
    expect(keys.length).toBe(8);
  });

  it('find_similar description mentions url and concept inputs', () => {
    const desc = TOOL_DESCRIPTIONS.find_similar;
    expect(desc).toContain('url');
    expect(desc).toContain('concept');
  });

  it('find_similar description mentions similarity/related', () => {
    const desc = TOOL_DESCRIPTIONS.find_similar;
    expect(desc).toMatch(/similar|related/i);
  });

  it('research description mentions depth levels', () => {
    const desc = TOOL_DESCRIPTIONS.research;
    expect(desc).toContain('quick');
    expect(desc).toContain('standard');
    expect(desc).toContain('comprehensive');
  });

  it('research description mentions synthesis/report', () => {
    const desc = TOOL_DESCRIPTIONS.research;
    expect(desc).toMatch(/synthe|report/i);
  });

  it('research description mentions sub-queries', () => {
    const desc = TOOL_DESCRIPTIONS.research;
    expect(desc).toMatch(/sub.?quer|decompos/i);
  });

  it('agent description mentions prompt-driven workflow', () => {
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toContain('prompt');
  });

  it('agent description mentions schema extraction', () => {
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toContain('schema');
  });

  it('agent description mentions steps/transparency', () => {
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toMatch(/step|transparen/i);
  });

  it('agent description mentions max_pages and max_time_ms', () => {
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toContain('max_pages');
    expect(desc).toContain('max_time_ms');
  });

  it('search description mentions format: answer', () => {
    const desc = TOOL_DESCRIPTIONS.search;
    expect(desc).toContain('answer');
  });

  it('search description mentions multi-query array', () => {
    const desc = TOOL_DESCRIPTIONS.search;
    expect(desc).toMatch(/array|multi.*query/i);
  });

  it('each description is a non-empty string under 2000 chars', () => {
    for (const [key, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(50);
      expect(desc.length).toBeLessThan(2000);
    }
  });

  it('no description contains code or imports', () => {
    for (const [key, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(desc).not.toContain('import ');
      expect(desc).not.toContain('require(');
    }
  });

  it('all existing v2 descriptions are preserved', () => {
    expect(TOOL_DESCRIPTIONS.fetch).toContain('section');
    expect(TOOL_DESCRIPTIONS.fetch).toContain('render_js');
    expect(TOOL_DESCRIPTIONS.crawl).toContain('sitemap');
    expect(TOOL_DESCRIPTIONS.cache).toContain('FTS5');
    expect(TOOL_DESCRIPTIONS.extract).toContain('schema');
  });
});

describe('ToolName type', () => {
  it('includes all v3 tool names', () => {
    const validNames: ToolName[] = [
      'fetch', 'search', 'crawl', 'cache', 'extract',
      'find_similar', 'research', 'agent',
    ];
    expect(validNames.length).toBe(8);
  });
});
