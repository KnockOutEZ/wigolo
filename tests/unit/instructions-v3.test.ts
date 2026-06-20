import { describe, it, expect } from 'vitest';
import {
  WIGOLO_INSTRUCTIONS,
  WIGOLO_INSTRUCTIONS_FULL,
  TOOL_DESCRIPTIONS,
} from '../../src/instructions.js';
import type { ToolName } from '../../src/instructions.js';

describe('WIGOLO_INSTRUCTIONS v3 routing patterns (per-session)', () => {
  it('mentions all v3 tools by name', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('find_similar');
    expect(WIGOLO_INSTRUCTIONS).toContain('research');
    expect(WIGOLO_INSTRUCTIONS).toContain('agent');
  });

  it('contains documentation lookup routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('include_domains');
  });

  it('contains category param hint', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('cache');
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
    expect(WIGOLO_INSTRUCTIONS).toMatch(/before.*(search|fetch|going to the network)/i);
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
});

describe('WIGOLO_INSTRUCTIONS_FULL v3 routing patterns (resource)', () => {
  it('contains the error debugging routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toMatch(/error/i);
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('category');
  });

  it('contains multi-query guidance', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toMatch(/multi.*query|array.*query|semantically.*varied/i);
  });

  it('preserves existing v2 routing guidance moved to the full doc', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('localhost');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('use_auth');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('full-text search syntax');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('sitemap');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('include_patterns');
  });
});

describe('TOOL_DESCRIPTIONS v3 entries', () => {
  it('has all tool descriptions (8 v3 tools + slice A1 stubs)', () => {
    const keys = Object.keys(TOOL_DESCRIPTIONS);
    expect(keys).toContain('fetch');
    expect(keys).toContain('search');
    expect(keys).toContain('crawl');
    expect(keys).toContain('cache');
    expect(keys).toContain('extract');
    expect(keys).toContain('find_similar');
    expect(keys).toContain('research');
    expect(keys).toContain('agent');
    // Slice A1 (2026-05-26): registration-only stubs for `diff` (slice B1)
    // and `watch` (slice B3). Real implementations land in those slices.
    expect(keys).toContain('diff');
    expect(keys).toContain('watch');
    // Phase 2H: the first studio_* tool — the agent's read-only perception of the session.
    expect(keys).toContain('studio_observe');
    // Phase 2I: the agent's acting verb in the session (navigate; click/type/scroll later).
    expect(keys).toContain('studio_act');
    // Phase 3c: the agent reads the human's marks.
    expect(keys).toContain('studio_marks');
    // Phase 4c: the agent persists a capture (clip) to the cache as a session artifact.
    expect(keys).toContain('studio_capture');
    expect(keys.length).toBe(14);
  });

  it('studio_act description covers navigation, the control token, and the private/metadata block', () => {
    const desc = TOOL_DESCRIPTIONS.studio_act;
    expect(desc).toMatch(/navigat/i);
    expect(desc).toMatch(/control|hold|turn|took over/i); // token-gated
    expect(desc).toMatch(/private|local|internal|blocked/i); // SSRF posture, capability language
    expect(desc).not.toContain('CDP'); // no implementation names (user-facing)
  });

  it('studio_observe description marks the snapshot content as untrusted page data, not instructions (Phase 6a trust boundary)', () => {
    const desc = TOOL_DESCRIPTIONS.studio_observe;
    expect(desc).toMatch(/untrusted|not instructions|page-derived/i); // the agent must treat page content as data
    expect(desc).toMatch(/instruction/i); // explicitly: page content is not instructions
    expect(desc).not.toContain('CDP'); // no implementation names (user-facing)
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
    expect(TOOL_DESCRIPTIONS.cache).toContain('AND, OR, NOT');
    expect(TOOL_DESCRIPTIONS.extract).toContain('schema');
  });
});

describe('ToolName type', () => {
  it('includes all tool names (v3 plus slice A1 stubs)', () => {
    // Slice A1 (2026-05-26): the ToolName union expanded to include `diff`
    // (slice B1) and `watch` (slice B3). The TS compiler will reject this
    // literal if either name is missing from the union — that is the
    // contract this test locks in.
    const validNames: ToolName[] = [
      'fetch', 'search', 'crawl', 'cache', 'extract',
      'find_similar', 'research', 'agent', 'diff', 'watch', 'studio_observe', 'studio_act', 'studio_marks', 'studio_capture',
    ];
    expect(validNames.length).toBe(14);
  });
});
