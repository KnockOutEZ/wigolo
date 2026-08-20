import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * The overlay preload must be self-contained, and until now that was a comment.
 *
 * `src/preload/overlay.ts` is installed into a SANDBOXED WebContentsView, which can load its own
 * preload file and nothing else. The moment the two preload entries share one runtime module, Rollup
 * stops inlining and emits `out/preload/chunk-*.cjs` for the shared part — a file the sandboxed
 * context cannot require. The overlay then throws before it installs, which means the marking overlay
 * simply never appears over the live page: no error in the app, no failing test, no build warning. It
 * is the quietest way to lose a whole feature in this app.
 *
 * Two halves, deliberately. This file asserts the SOURCE-level invariant — the two entry graphs are
 * disjoint — because it runs on every push and points at the import that did it. `tests/e2e/
 * preload-bundle.spec.ts` asserts the BUILT shape, because Rollup's output is the thing that actually
 * has to be two files and no `chunk-*.cjs`, and only a real build can say so.
 */

const PRELOAD_CONFIG = readFileSync(join(import.meta.dirname, '../../electron.vite.config.ts'), 'utf8');
const SRC = join(import.meta.dirname, '../../src');

const ENTRIES = { index: 'preload/index.ts', overlay: 'preload/overlay.ts' } as const;

/** Resolve a relative specifier the way the bundler does — extensionless, `.ts`/`.tsx`, or a folder. */
function resolveModule(fromFile: string, specifier: string): string | null {
  const base = join(dirname(join(SRC, fromFile)), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return relative(SRC, candidate);
  }
  return null;
}

/**
 * Every relative module an entry pulls in, transitively.
 *
 * Bare specifiers (`electron`, `wigolo/studio`) are left out: they are external to the preload bundle,
 * so sharing one emits no chunk. `import type` is left out because TypeScript erases it — and that
 * distinction is the whole reason this is a real check rather than a formality, since the two entries
 * already share several TYPES and must go on being allowed to.
 */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(SRC, file), 'utf8');
    for (const [, statement, specifier] of source.matchAll(
      /((?:import|export)\s+(?:type\s+)?[^;'"]*?from\s+|import\s+)['"](\.[^'"]*)['"]/g,
    )) {
      if (/^(?:import|export)\s+type\s/.test(statement)) continue;
      const resolved = resolveModule(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  seen.delete(entry);
  return seen;
}

describe('the two preload entries share no runtime module', () => {
  const index = moduleGraph(ENTRIES.index);
  const overlay = moduleGraph(ENTRIES.overlay);

  it('reads a real graph off both entries, or the disjointness below is a claim about nothing', () => {
    // The control. If the import scanner stopped matching, both sets would be empty and disjoint, and
    // this file would go green on a build that emits a chunk.
    expect([...overlay]).toContain('preload/overlay-core.ts');
    expect([...overlay]).toContain('renderer/tokens.ts');
    expect([...index]).toContain('shared/ipc.ts');
  });

  it('has an empty intersection, because a shared module is a chunk the sandbox cannot load', () => {
    const shared = [...overlay].filter((module) => index.has(module));
    expect(shared).toEqual([]);
  });

  it('would name the module if one were shared', () => {
    // Must-fire for the assertion above, run through the same graph walker: `overlay.ts` already
    // depends on the token layer, so the token layer is the likeliest thing the chrome preload reaches
    // for next — and the next contributor to do it has no way to know what it costs.
    const wouldShare = [...moduleGraph(ENTRIES.overlay)].filter((m) => m === 'renderer/tokens.ts');
    expect(wouldShare).toEqual(['renderer/tokens.ts']);
    // …and a type-only import of the same module must NOT count, or the check bans something legal.
    const typeOnly = `import type { Register } from '../renderer/tokens';\nimport { ipcRenderer } from 'electron';`;
    expect([...typeOnly.matchAll(/((?:import|export)\s+(?:type\s+)?[^;'"]*?from\s+)['"](\.[^'"]*)['"]/g)]
      .filter(([statement]) => !/^(?:import|export)\s+type\s/.test(statement))).toEqual([]);
  });
});

describe('the bundler is configured to emit one file per preload entry', () => {
  it('declares both entries, so neither is bundled into the other', () => {
    expect(PRELOAD_CONFIG).toContain("index: resolve(__dirname, 'src/preload/index.ts')");
    expect(PRELOAD_CONFIG).toContain("overlay: resolve(__dirname, 'src/preload/overlay.ts')");
  });

  it('disables code splitting and emits CommonJS, which the sandboxed context requires', () => {
    // `manualChunks: undefined` is not a no-op default here — it is the instruction that keeps shared
    // code inlined per entry. `format: 'cjs'` is the sandbox's other hard constraint: Electron cannot
    // load an ESM preload in a sandboxed context and fails silently when asked to.
    const output = /output:\s*\{([^}]*)\}/.exec(PRELOAD_CONFIG);
    expect(output, 'the preload output block moved').not.toBeNull();
    expect(output![1]).toContain('manualChunks: undefined');
    expect(output![1]).toContain("format: 'cjs'");
    expect(output![1]).toContain("entryFileNames: '[name].cjs'");
  });
});
