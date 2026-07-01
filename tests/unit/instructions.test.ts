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

  it('is under 3 KB so it stays cheap to inject every session', () => {
    expect(WIGOLO_INSTRUCTIONS.length).toBeLessThan(3072);
  });

  it('points readers to the wigolo://docs/usage resource for the long guide', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain(WIGOLO_DOCS_URI);
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
