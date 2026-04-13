import { describe, it, expect } from 'vitest';
import { WIGOLO_INSTRUCTIONS, TOOL_DESCRIPTIONS } from '../../../src/instructions.js';

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

describe('WIGOLO_INSTRUCTIONS (Layer 1 — server strategy)', () => {
  it('is a non-empty string', () => {
    expect(typeof WIGOLO_INSTRUCTIONS).toBe('string');
    expect(WIGOLO_INSTRUCTIONS.trim().length).toBeGreaterThan(0);
  });

  it('is within 300–500 words so clients do not truncate it', () => {
    const count = wordCount(WIGOLO_INSTRUCTIONS);
    expect(count).toBeGreaterThanOrEqual(300);
    expect(count).toBeLessThanOrEqual(500);
  });

  it('mentions every tool by name at least once (tool selection guidance)', () => {
    for (const tool of ['search', 'fetch', 'crawl', 'cache', 'extract']) {
      expect(WIGOLO_INSTRUCTIONS).toContain(tool);
    }
  });

  it('teaches the cache-first workflow', () => {
    expect(WIGOLO_INSTRUCTIONS.toLowerCase()).toMatch(/check .*cache|cache.*first|before.*search/);
  });

  it('teaches sitemap strategy for documentation sites', () => {
    expect(WIGOLO_INSTRUCTIONS).toMatch(/sitemap/);
  });

  it('teaches the map strategy for URL discovery', () => {
    expect(WIGOLO_INSTRUCTIONS.toLowerCase()).toContain('map');
  });

  it('teaches the schema mode for structured extraction', () => {
    expect(WIGOLO_INSTRUCTIONS).toMatch(/schema/);
  });

  it('surfaces the less-obvious localhost capability', () => {
    expect(WIGOLO_INSTRUCTIONS.toLowerCase()).toContain('localhost');
  });

  it('surfaces the less-obvious use_auth capability', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('use_auth');
  });

  it('does not use marketing filler', () => {
    const filler = /\b(powerful|seamlessly|leverage|cutting[- ]edge|revolutionary|world[- ]class)\b/i;
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(filler);
  });

  it('does not advertise features that are not implemented', () => {
    // format: "context" appears in the design spec but not in SearchInput — must not appear in instructions
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(/format:\s*["']context["']/);
    // change detection (changed: true/false) is v2 — must not appear
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(/changed:\s*true/);
  });

  it('does not duplicate Layer 2 parameter-schema details (strategy teaches STRATEGY)', () => {
    // Parameter descriptions live on the JSON schema / tool descriptions, not here.
    // Heuristic: Layer 1 should not read like a field list — no "Key parameters:" header.
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(/^\s*Key parameters:/m);
  });
});

describe('TOOL_DESCRIPTIONS (Layer 2 — per-tool tactics)', () => {
  const REQUIRED_TOOLS = ['fetch', 'search', 'crawl', 'cache', 'extract'] as const;

  it('has an entry for each of the 5 tools', () => {
    for (const tool of REQUIRED_TOOLS) {
      expect(TOOL_DESCRIPTIONS[tool]).toBeTypeOf('string');
      expect((TOOL_DESCRIPTIONS[tool] as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps each description within 50–200 words', () => {
    for (const tool of REQUIRED_TOOLS) {
      const count = wordCount(TOOL_DESCRIPTIONS[tool]);
      expect(count, `${tool} description word count`).toBeGreaterThanOrEqual(50);
      expect(count, `${tool} description word count`).toBeLessThanOrEqual(200);
    }
  });

  describe('fetch description', () => {
    const d = () => TOOL_DESCRIPTIONS.fetch;
    it('names the key parameters', () => {
      expect(d()).toContain('section');
      expect(d()).toContain('use_auth');
      expect(d()).toContain('render_js');
    });
    it('mentions caching and localhost capability', () => {
      expect(d().toLowerCase()).toMatch(/cache/);
      expect(d().toLowerCase()).toContain('localhost');
    });
    it('describes the output shape', () => {
      expect(d().toLowerCase()).toMatch(/markdown/);
    });
  });

  describe('search description', () => {
    const d = () => TOOL_DESCRIPTIONS.search;
    it('names the key parameters', () => {
      expect(d()).toContain('include_domains');
      expect(d()).toContain('category');
      expect(d()).toContain('max_results');
    });
    it('describes markdown-in-results output', () => {
      expect(d()).toMatch(/markdown/);
    });
    it('does not advertise the non-existent format:"context" option', () => {
      expect(d()).not.toMatch(/format:\s*["']context["']/);
    });
  });

  describe('crawl description', () => {
    const d = () => TOOL_DESCRIPTIONS.crawl;
    it('names every strategy', () => {
      for (const s of ['bfs', 'dfs', 'sitemap', 'map']) {
        expect(d()).toContain(s);
      }
    });
    it('names depth/pages/pattern parameters', () => {
      expect(d()).toContain('max_depth');
      expect(d()).toContain('max_pages');
      expect(d()).toMatch(/include_patterns|exclude_patterns/);
    });
  });

  describe('cache description', () => {
    const d = () => TOOL_DESCRIPTIONS.cache;
    it('names the key parameters', () => {
      expect(d()).toContain('query');
      expect(d()).toContain('url_pattern');
      expect(d()).toContain('since');
      expect(d()).toContain('stats');
      expect(d()).toContain('clear');
    });
    it('mentions FTS5 syntax (real capability of the cache)', () => {
      expect(d()).toMatch(/FTS5/);
    });
  });

  describe('extract description', () => {
    const d = () => TOOL_DESCRIPTIONS.extract;
    it('names every mode', () => {
      for (const m of ['selector', 'tables', 'metadata', 'schema']) {
        expect(d()).toContain(m);
      }
    });
    it('names the key parameters', () => {
      expect(d()).toContain('css_selector');
      expect(d()).toContain('schema');
    });
  });
});
