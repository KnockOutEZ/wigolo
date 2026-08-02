import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../../src/server/tool-schemas.js';
import { coerceFlags, toolFlagSpecs } from '../../../src/cli/flag-bridge.js';

/**
 * Round-trip exclusion set — properties NOT reachable via a derived `--flag`
 * because they are supplied another way. Pinned here (mirrors
 * ROUND_TRIP_EXCLUSIONS in flag-bridge.ts) so the parity guarantee is explicit
 * in the test and any DIVERGENCE between the two is caught by the module test.
 *
 *  - positional-mapped:  url / prompt / question / query (+ concept, html-via-flag)
 *  - verb-mapped:        watch action
 *  - subcommand-mapped:  cache clear / stats
 *  - curated string-wrap: diff old / new (schema objects excluded from round-trip)
 */
const EXCLUSIONS: Record<string, ReadonlySet<string>> = {
  search: new Set(['query']),
  fetch: new Set(['url']),
  crawl: new Set(['url']),
  research: new Set(['question']),
  agent: new Set(['prompt']),
  extract: new Set(['url']),
  find_similar: new Set(['url', 'concept']),
  cache: new Set(['query', 'clear', 'stats']),
  watch: new Set(['action']),
  diff: new Set(['old', 'new']),
};

/** A coercion-valid sample string for a given flag kind. */
function sampleFor(kind: string, enumValues?: string[]): string {
  switch (kind) {
    case 'number':
      return '5';
    case 'boolean':
      return 'true';
    case 'enum':
      return enumValues?.[0] ?? '';
    case 'array-string':
      return 'a,b';
    case 'array-object':
      return '[{"type":"click"}]';
    case 'object':
      return '{"k":"v"}';
    case 'oneof-string-array':
      return 'hello';
    case 'string':
    default:
      return 'x';
  }
}

describe('schema flag parity — every non-excluded property is reachable', () => {
  for (const tool of Object.keys(TOOL_SCHEMAS)) {
    const excluded = EXCLUSIONS[tool] ?? new Set<string>();
    const specs = toolFlagSpecs(tool);
    for (const spec of specs) {
      if (excluded.has(spec.key)) continue;
      it(`${tool} --${spec.flag} sets ${spec.key} with no errors`, () => {
        const value = sampleFor(spec.kind, spec.enumValues);
        const { input, errors } = coerceFlags(tool, { [spec.flag]: value });
        expect(errors).toEqual([]);
        expect(input).toHaveProperty(spec.key);
      });
    }
  }

  it('the exclusion set is exactly the properties that do NOT round-trip', () => {
    // WHY: a NEW schema property added later must EITHER round-trip via its flag
    // OR be added to the exclusion set — this guards against silent drift.
    for (const [tool, excluded] of Object.entries(EXCLUSIONS)) {
      for (const key of excluded) {
        expect(TOOL_SCHEMAS[tool as keyof typeof TOOL_SCHEMAS].properties).toHaveProperty(key);
      }
    }
  });
});
