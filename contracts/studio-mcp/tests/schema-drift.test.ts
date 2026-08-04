import { describe, it, expect } from 'vitest';
import { STUDIO_TOOL_NAMES, STUDIO_UNADVERTISED_CAPABILITY, CORE_TOOL_NAMES_ABSENT_FROM_STUDIO } from '../src/tool-names.js';
import { STUDIO_TOOL_SCHEMAS } from '../src/schemas.js';
import { TOOL_SCHEMAS } from '../../../src/server/tool-schemas.js';
import { TOOL_DESCRIPTIONS } from '../../../src/instructions.js';
import { STUDIO_FETCH_CAPABILITY } from '../../../src/studio/studio-fetch.js';

/**
 * THE DRIFT CHECK — the price of the contract owning a copy of the schemas instead of re-exporting them.
 *
 * `src/schemas.ts` explains why the copy exists. This is the part that makes the copy safe: a copy that
 * can silently diverge from the implementation is worse than no contract at all, because it reads as a
 * passing gate while agents get a surface nobody declared. So every property that could drift is
 * compared in BOTH directions:
 *
 *  - a tool present on one side and not the other,
 *  - a schema whose properties, requireds, enums, descriptions or `additionalProperties` differ,
 *  - the unadvertised capability's NAME, which is shared by the host seam and the core-side client and
 *    whose drift is a silent 404 rather than a type error,
 *  - the core surface, which must stay entirely off the studio endpoint.
 *
 * This is the ONLY file in the package that imports core. After a repo split it becomes a check against
 * a published version of core instead of a relative path; until then the relative import is what gives
 * it teeth, because it reads the working tree rather than a build artifact.
 */
describe('studio_* schema contract vs core', () => {
  it('declares exactly the studio tool names core declares — a tool added on one side only reds here, in both directions', () => {
    const coreStudio = Object.keys(TOOL_SCHEMAS).filter((n) => n.startsWith('studio_')).sort();
    expect([...STUDIO_TOOL_NAMES]).toEqual(coreStudio);
  });

  it('carries a schema for every name it declares, and no extras', () => {
    expect(Object.keys(STUDIO_TOOL_SCHEMAS).sort()).toEqual([...STUDIO_TOOL_NAMES]);
  });

  // Per-tool rather than one whole-object compare: a single `toEqual` on the whole record reports the
  // first difference and buries the rest, and the point of a drift check is to name what moved.
  for (const name of STUDIO_TOOL_NAMES) {
    it(`${name}: the contract schema is byte-for-byte core's — properties, requireds, enums, descriptions and additionalProperties`, () => {
      const core = (TOOL_SCHEMAS as Record<string, unknown>)[name];
      // toStrictEqual, not toEqual: `additionalProperties` is ABSENT on three of the ten schemas and
      // present on seven, and toEqual treats an absent key and an explicit `undefined` as equal — which
      // is exactly the difference that would let the asymmetry drift unnoticed.
      expect(STUDIO_TOOL_SCHEMAS[name]).toStrictEqual(core);
    });
  }

  it('names the unadvertised capability the same string core does — drift here is a silent 404 on the escalation rung, not a type error', () => {
    expect(STUDIO_UNADVERTISED_CAPABILITY).toBe(STUDIO_FETCH_CAPABILITY);
  });

  it('keeps the unadvertised capability out of the declared tool set', () => {
    expect(STUDIO_TOOL_NAMES as readonly string[]).not.toContain(STUDIO_UNADVERTISED_CAPABILITY);
    expect(Object.keys(TOOL_SCHEMAS)).not.toContain(STUDIO_UNADVERTISED_CAPABILITY);
  });

  it('lists exactly core\'s non-studio tools as the set that must never appear on a studio endpoint', () => {
    const coreOnly = Object.keys(TOOL_DESCRIPTIONS).filter((n) => !n.startsWith('studio_')).sort();
    expect([...CORE_TOOL_NAMES_ABSENT_FROM_STUDIO]).toEqual(coreOnly);
  });
});
