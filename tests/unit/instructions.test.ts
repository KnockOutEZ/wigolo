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

  it('stays lean (~3.4 KB) so it is cheap to inject every session', () => {
    // Per-session injection budget — keep additions terse. Raised from 3072 → 3300
    // (11th tool, studio_observe, Phase 2H) → 3400 (12th tool, studio_act, Phase 2I) →
    // 3500 (13th tool, studio_marks, Phase 3c) → 3600 (14th tool, studio_capture, Phase 4c:
    // its list entry only — no routing bullet, per the frugal cadence) → 3900 (S6: the 3 lifecycle
    // verbs studio_spawn/close/list, tool-list entry only, no routing bullets — same frugal cadence).
    expect(WIGOLO_INSTRUCTIONS.length).toBeLessThan(3900);
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

  it('routes the pin-8 studio capabilities in the per-session body, inside the char budget', () => {
    // The per-session body is the ONLY layer an agent reads before it picks a tool, so a capability
    // that exists solely in the per-tool description is invisible at routing time. Both new ones are
    // one clause each precisely because this block is capped.
    expect(WIGOLO_INSTRUCTIONS).toContain('`find` greps the live page');
    expect(WIGOLO_INSTRUCTIONS).toContain('results report what the page became');
    expect(WIGOLO_INSTRUCTIONS.length).toBeLessThan(3900);
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
      ['agent', 'cache', 'crawl', 'diff', 'extract', 'fetch', 'find_similar', 'research', 'search', 'studio_open', 'studio_observe', 'studio_act', 'studio_marks', 'studio_capture', 'studio_extract_set', 'studio_say', 'studio_spawn', 'studio_close', 'studio_list', 'watch'].sort(),
    );
  });
});
