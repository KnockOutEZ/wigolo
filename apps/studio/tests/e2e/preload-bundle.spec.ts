import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// GATED (RUN_STUDIO_E2E) — needs the real build output, which `npm run test:e2e` produces before this
// runs. It launches nothing, so it costs a directory listing on the lane that already paid for a build.
const RUN = !!process.env.RUN_STUDIO_E2E;
const PRELOAD_OUT = join(import.meta.dirname, '../../out/preload');

/**
 * The BUILT shape of the preload bundle, which is the only place the self-containment invariant is
 * really decided.
 *
 * `tests/unit/preload-self-contained.test.ts` asserts the source-level property — the two entry graphs
 * are disjoint — and names the offending import when it breaks. It cannot see what Rollup does with
 * them. This can: the moment the entries share a runtime module, code splitting emits a third file
 * (`chunk-*.cjs`) and the entries `require` it. The chrome preload loads it fine. The overlay preload
 * runs in a sandboxed WebContentsView that cannot, so it throws before installing and the marking
 * overlay silently never appears — no error surface, no failing test, and a screenshot of the app looks
 * completely normal.
 *
 * Asserted as an exact set rather than as "no chunk files": a build that renamed the entries, or split
 * under a name we did not predict, is the same class of failure.
 */
describe.skipIf(!RUN)('the preload bundle is exactly two self-contained files (e2e, real build)', () => {
  it('emits index.cjs and overlay.cjs and nothing else', () => {
    const emitted = readdirSync(PRELOAD_OUT).sort();
    // Fails loudly on an unbuilt tree rather than reporting an empty directory as a clean result.
    expect(emitted.length, `${PRELOAD_OUT} is empty — the build did not run`).toBeGreaterThan(0);
    expect(emitted).toEqual(['index.cjs', 'overlay.cjs']);
  });

  it('leaves the overlay requiring nothing but the browser engine it is loaded by', () => {
    // The sandbox constraint restated as a property of the artifact: `electron` is injected into a
    // sandboxed preload, and a `require` of anything else is a throw at install time.
    const overlay = readdirSync(PRELOAD_OUT, { withFileTypes: true })
      .find((entry) => entry.name === 'overlay.cjs');
    expect(overlay, 'overlay.cjs was not emitted').toBeDefined();
    const source = readFileSync(join(PRELOAD_OUT, 'overlay.cjs'), 'utf8');
    const required = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect([...new Set(required)].sort()).toEqual(['electron']);
  });
});
