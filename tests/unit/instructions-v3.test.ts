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

  it('mentions the opt-in local language model knob with capability language', () => {
    // WHY: the local-model tier is a keyless quality lever; the host LLM should
    // learn it exists. The knob name is asserted so the surface tracks the config
    // contract (memory: config-param change → instructions body + this test).
    expect(WIGOLO_INSTRUCTIONS).toContain('WIGOLO_LOCAL_LLM');
    expect(WIGOLO_INSTRUCTIONS).toMatch(/local language model/i);
  });

  it('uses capability language for the local model — never a vendor name', () => {
    // WHY: user-facing text must say "local language model", not the component
    // name. Vendor names are allowed only in warmup/doctor troubleshooting.
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(/ollama/i);
  });

  it('teaches honest research/agent degradation — host LLM synthesizes when no key is set', () => {
    // WHY: research/agent are LLM-optional. Without a synthesis LLM they return a
    // brief / evidence / step log, and the host model must write the final answer
    // ITSELF rather than dump the raw structure as a weak result. If this guidance
    // is dropped, hosts hand users the raw brief and research/agent read as broken.
    expect(WIGOLO_INSTRUCTIONS).toMatch(/LLM-optional/i);
    expect(WIGOLO_INSTRUCTIONS).toMatch(/YOU write the final answer/i);
    expect(WIGOLO_INSTRUCTIONS).toMatch(/raw structure/i);
  });

  it('recommends the free Gemini key as the research/agent quality unlock (honest, keyless-core-preserving)', () => {
    // WHY: the honest UX is "core stays keyless; research/agent synthesis unlocks
    // with a (free) key." The instruction names the exact env config a user sets
    // (provider name Gemini is allowed — it is user config, not an internal dep)
    // and reaffirms that the core tools stay keyless so we never undercut that.
    expect(WIGOLO_INSTRUCTIONS).toMatch(/free Gemini API key/i);
    expect(WIGOLO_INSTRUCTIONS).toContain('WIGOLO_LLM_PROVIDER=gemini');
    expect(WIGOLO_INSTRUCTIONS).toContain('GEMINI_API_KEY');
    expect(WIGOLO_INSTRUCTIONS).toMatch(/core .*(search|fetch).*keyless/i);
  });

  it('never routes users to a competing browser-automation MCP (off-brand + inaccurate)', () => {
    // WHY: wigolo drives interactive page actions itself (fetch `actions` +
    // `use_auth`), so "when NOT to use wigolo → use a dedicated browser-automation
    // MCP" is both off-brand and factually wrong. This negative guard fails if that
    // competitor-routing marketing is ever reintroduced into any user-facing surface.
    const surfaces = [WIGOLO_INSTRUCTIONS, WIGOLO_INSTRUCTIONS_FULL, ...Object.values(TOOL_DESCRIPTIONS)].join('\n');
    expect(surfaces).not.toMatch(/browser[- ]automation MCP/i);
    expect(surfaces).not.toMatch(/dedicated .{0,40}\bMCP\b/i);
    expect(surfaces).not.toMatch(/defer to a browser/i);
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(/when NOT to use wigolo/i);
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

  it('documents the opt-in local language model tier with capability language', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('WIGOLO_LOCAL_LLM');
    expect(WIGOLO_INSTRUCTIONS_FULL).toMatch(/local language model/i);
    expect(WIGOLO_INSTRUCTIONS_FULL).not.toMatch(/ollama/i);
  });
});

describe('TOOL_DESCRIPTIONS v3 entries', () => {
  it('has all 10 tool descriptions', () => {
    const keys = Object.keys(TOOL_DESCRIPTIONS);
    expect(keys).toContain('fetch');
    expect(keys).toContain('search');
    expect(keys).toContain('crawl');
    expect(keys).toContain('cache');
    expect(keys).toContain('extract');
    expect(keys).toContain('find_similar');
    expect(keys).toContain('research');
    expect(keys).toContain('agent');
    expect(keys).toContain('diff');
    expect(keys).toContain('watch');
    expect(keys.length).toBe(10);
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

  it('research description degrades honestly — host writes the answer + free-key recommendation', () => {
    // WHY: with no synthesis LLM, research returns a structured brief, not prose.
    // The description must tell the caller to synthesize from the brief (not hand
    // over the raw structure) and recommend a free key for best quality — without
    // this, the tool reads as a poor result whenever no LLM is configured.
    const desc = TOOL_DESCRIPTIONS.research;
    expect(desc).toMatch(/LLM-optional/i);
    expect(desc).toMatch(/without one/i);
    expect(desc).toMatch(/key_findings|brief/);
    expect(desc).toMatch(/free Gemini API key/i);
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

  it('agent description degrades honestly — host writes the summary + free-key recommendation', () => {
    // WHY: with no synthesis LLM, agent returns gathered evidence + a step log,
    // not a written summary. The description must tell the caller to write the
    // summary from the evidence itself and recommend a free LLM key — otherwise
    // the raw step log gets surfaced as a weak result.
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toMatch(/LLM-optional/i);
    expect(desc).toMatch(/without one/i);
    expect(desc).toMatch(/evidence/i);
    expect(desc).toMatch(/free LLM key|Gemini/i);
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

  it('fetch description advertises its OWN interactive capability (actions + use_auth), not a competitor', () => {
    // WHY: fetch handles click/scroll/login pages itself via the `actions` input
    // (click/type/scroll/wait, verified in the fetch schema) and `use_auth`. The
    // old text deferred these flows to a browser-automation MCP — off-brand and
    // wrong. This asserts the positive capability replaced it and the deferral is gone.
    const desc = TOOL_DESCRIPTIONS.fetch;
    expect(desc).toContain('actions');
    expect(desc).toContain('use_auth');
    expect(desc).toMatch(/click/i);
    expect(desc).not.toMatch(/browser[- ]automation MCP/i);
    expect(desc).not.toMatch(/defer to a browser/i);
  });
});

describe('ToolName type', () => {
  it('includes all tool names', () => {
    // The ToolName union includes `diff` and `watch`. The TS compiler will
    // reject this literal if either name is missing from the union — that is
    // the contract this test locks in.
    const validNames: ToolName[] = [
      'fetch', 'search', 'crawl', 'cache', 'extract',
      'find_similar', 'research', 'agent', 'diff', 'watch',
    ];
    expect(validNames.length).toBe(10);
  });
});
