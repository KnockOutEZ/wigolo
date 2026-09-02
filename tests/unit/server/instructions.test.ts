import { describe, it, expect } from 'vitest';
import { encode } from 'gpt-tokenizer';
import {
  ACTIVATION_NOTICE,
  WIGOLO_INSTRUCTIONS,
  WIGOLO_INSTRUCTIONS_FULL,
  TOOL_DESCRIPTIONS,
  serverInstructions,
} from '../../../src/instructions.js';

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

describe('WIGOLO_INSTRUCTIONS (Layer 1 — per-session strategy)', () => {
  // PX2 #222: an un-activated install prepends a one-line activation notice to
  // this string. The notice is COMPOSED at server construction and must never be
  // baked into the constant — every word-budget assertion in this block is
  // written against the activated form, and an install that has registered must
  // receive exactly what it received before 0.3.0.
  it('is exactly what an activated session receives — the notice is composed, not baked in', () => {
    expect(serverInstructions(true)).toBe(WIGOLO_INSTRUCTIONS);
    expect(WIGOLO_INSTRUCTIONS).not.toContain(ACTIVATION_NOTICE);
    expect(serverInstructions(false)).toBe(`${ACTIVATION_NOTICE}\n\n${WIGOLO_INSTRUCTIONS}`);
  });

  it('is a non-empty string', () => {
    expect(typeof WIGOLO_INSTRUCTIONS).toBe('string');
    expect(WIGOLO_INSTRUCTIONS.trim().length).toBeGreaterThan(0);
  });

  it('is within 150–500 words so it stays cheap to inject every session', () => {
    const count = wordCount(WIGOLO_INSTRUCTIONS);
    expect(count).toBeGreaterThanOrEqual(150);
    expect(count).toBeLessThanOrEqual(500);
  });

  it('mentions every tool by name at least once (tool selection guidance)', () => {
    for (const tool of ['search', 'fetch', 'crawl', 'cache', 'extract', 'find_similar', 'research', 'agent']) {
      expect(WIGOLO_INSTRUCTIONS).toContain(tool);
    }
  });

  it('teaches the cache-first workflow', () => {
    expect(WIGOLO_INSTRUCTIONS.toLowerCase()).toMatch(/check .*cache|cache.*first|before.*(search|going to the network)/);
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

  it('does not use marketing filler', () => {
    const filler = /\b(powerful|seamlessly|leverage|cutting[- ]edge|revolutionary|world[- ]class)\b/i;
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(filler);
  });

  it('does not advertise features that are not implemented', () => {
    // change detection (changed: true/false) is v2 — must not appear
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(/changed:\s*true/);
  });

  it('does not duplicate Layer 2 parameter-schema details (strategy teaches STRATEGY)', () => {
    // Parameter descriptions live on the JSON schema / tool descriptions, not here.
    // Heuristic: Layer 1 should not read like a field list — no "Key parameters:" header.
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(/^\s*Key parameters:/m);
  });

  it('points readers to the wigolo://docs/usage resource for the long guide', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('wigolo://docs/usage');
  });
});

describe('WIGOLO_INSTRUCTIONS_FULL (resource long form)', () => {
  it('surfaces the less-obvious localhost capability', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL.toLowerCase()).toContain('localhost');
  });

  it('surfaces the less-obvious use_auth capability', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('use_auth');
  });
});

describe('TOOL_DESCRIPTIONS (Layer 2 — per-tool tactics)', () => {
  const REQUIRED_TOOLS = ['fetch', 'search', 'crawl', 'cache', 'extract', 'find_similar', 'research', 'agent'] as const;

  it('has an entry for each of the 8 tools', () => {
    for (const tool of REQUIRED_TOOLS) {
      expect(TOOL_DESCRIPTIONS[tool]).toBeTypeOf('string');
      expect((TOOL_DESCRIPTIONS[tool] as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps each description within 50–300 words', () => {
    for (const tool of REQUIRED_TOOLS) {
      const count = wordCount(TOOL_DESCRIPTIONS[tool]);
      expect(count, `${tool} description word count`).toBeGreaterThanOrEqual(50);
      expect(count, `${tool} description word count`).toBeLessThanOrEqual(300);
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
    it('mentions the context and answer format options', () => {
      expect(d()).toContain('context');
      expect(d()).toContain('answer');
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
    it('mentions supported query operators (real capability of the cache)', () => {
      expect(d()).toMatch(/AND, OR, NOT/);
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

/**
 * PIN 8 (#57). Every description this issue touched grew, and the pin's own rule is that a tool
 * description is a budget, not a scratchpad — announcing a field is supposed to cost a trim first.
 * These arms hold the two reshaped descriptions to the budget in BOTH directions: still under the
 * per-tool cap, and still carrying the trims that paid for the additions rather than quietly
 * reverting to the longer phrasings.
 */
describe('reshaped studio descriptions stay inside the description budget', () => {
  const TOOL_DESC_BUDGET = 400;

  it.each(['studio_observe', 'studio_act'] as const)('%s is under the per-tool token budget', (name) => {
    const tokens = encode(TOOL_DESCRIPTIONS[name]).length;
    expect(tokens, `${name} is ${tokens} tokens (budget ${TOOL_DESC_BUDGET})`).toBeLessThanOrEqual(TOOL_DESC_BUDGET);
  });

  it('keeps the redundancy the pin-8 additions were paid for out of', () => {
    const observe = TOOL_DESCRIPTIONS.studio_observe;
    const act = TOOL_DESCRIPTIONS.studio_act;
    // `snapshot_ref` was named twice in one sentence ("spill to a snapshot_ref you retrieve by
    // calling studio_observe again with that snapshot_ref"); once is enough.
    expect(observe.split('snapshot_ref').length - 1).toBeLessThanOrEqual(1);
    expect(observe).not.toContain('the event cursor you last received');
    expect(act).not.toContain('resolved live at action time');
  });
});

