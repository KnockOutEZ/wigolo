import { describe, it, expect } from 'vitest';
import {
  WIGOLO_INSTRUCTIONS,
  WIGOLO_INSTRUCTIONS_FULL,
  WIGOLO_DOCS_URI,
  TOOL_DESCRIPTIONS,
} from '../../src/instructions.js';

describe('WIGOLO_INSTRUCTIONS (per-session)', () => {
  it('contains the host-LLM synthesis pattern + tool selection guide', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('Host-LLM synthesis');
    expect(WIGOLO_INSTRUCTIONS).toContain('search');
    expect(WIGOLO_INSTRUCTIONS).toContain('fetch');
    expect(WIGOLO_INSTRUCTIONS).toContain('research');
    expect(WIGOLO_INSTRUCTIONS).toContain('include_domains');
  });

  it('stays lean so it is cheap to inject every session', () => {
    // Per-session injection budget — keep additions terse. It climbed 3072 → 3900 one tool at a
    // time while core hosted the studio surface; the extraction handed all ten of those names back,
    // so the cap comes DOWN with them (3900 → 3250, ~75 bytes of headroom over the measured body)
    // rather than leaving 700 bytes nobody paid for. A tool added here is a deliberate raise, which
    // is the whole point of the number.
    expect(WIGOLO_INSTRUCTIONS.length).toBeLessThan(3250);
  });

  it('points readers to the wigolo://docs/usage resource for the long guide', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain(WIGOLO_DOCS_URI);
  });

  it('lists every conditional search response field an agent must know to read', () => {
    // WHY: the per-session body is the ONLY surface guaranteed to reach the host
    // model — the tool description is seen at call time and the full guide only
    // if the client fetches the resource. A field emitted only in a failure mode
    // (`domain_filter` on a scope-emptied response) is unreadable to an agent
    // that never learned the name, so it stays in this list.
    const fieldsSection = WIGOLO_INSTRUCTIONS.slice(WIGOLO_INSTRUCTIONS.indexOf('## Response fields'));
    for (const field of ['evidence_score', 'brand_collision_warning', 'domain_filter', 'ranking_notice']) {
      expect(fieldsSection, `'${field}' missing from the per-session response-field list`).toContain(field);
    }
  });

  it('routes only the tools core still hosts — no companion capability is advertised here', () => {
    // The per-session body is the ONLY layer an agent reads before it picks a tool, so a name left
    // behind here would route an agent at a tool core cannot dispatch: it would call it, get
    // `Unknown tool`, and have no way to learn where the capability went.
    expect(WIGOLO_INSTRUCTIONS).not.toContain('studio_');
    for (const tool of ['search', 'fetch', 'crawl', 'cache', 'extract', 'find_similar', 'research', 'agent', 'diff', 'watch']) {
      expect(WIGOLO_INSTRUCTIONS, `'${tool}' missing from the per-session routing body`).toContain(tool);
    }
  });
});

describe('WIGOLO_INSTRUCTIONS_FULL (resource)', () => {
  it('keeps the long-form usage detail (performance, extras, intent routing)', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('Routing by intent');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('Performance');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('Extras');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('Pick the right strategy');
  });

  it('is substantially longer than the trimmed instructions', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL.length).toBeGreaterThan(WIGOLO_INSTRUCTIONS.length * 1.5);
  });
});

describe('WIGOLO_DOCS_URI', () => {
  it('is a stable wigolo:// URI', () => {
    expect(WIGOLO_DOCS_URI).toMatch(/^wigolo:\/\//);
  });
});

describe('TOOL_DESCRIPTIONS', () => {
  it('has one description per public tool', () => {
    expect(Object.keys(TOOL_DESCRIPTIONS).sort()).toEqual(
      ['agent', 'cache', 'crawl', 'diff', 'extract', 'fetch', 'find_similar', 'research', 'search', 'watch'].sort(),
    );
  });
});
