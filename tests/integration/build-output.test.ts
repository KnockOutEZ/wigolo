import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// File-level: both suites below assert over `dist/`, so the build has to precede either of
// them, not just the first. This test is in the `spawn-serial` project on purpose — see the
// note in vitest.config.ts. Rebuilding dist/ anywhere else races the tests that read it.
beforeAll(() => {
  execSync('npm run build', { stdio: 'pipe' });
}, 120_000);

describe('build output (tsup)', () => {
  it('emits dist/index.js', () => {
    expect(existsSync('dist/index.js')).toBe(true);
  });

  it('emits type declarations', () => {
    expect(existsSync('dist/index.d.ts')).toBe(true);
    expect(existsSync('dist/types.d.ts')).toBe(true);
  });

  it('ships zero Python (no dist/scripts or dist/python)', () => {
    // Phase 4 removed the Python reranker subprocess. The build no longer
    // copies any Python assets — its absence is the contract we assert.
    expect(existsSync('dist/scripts')).toBe(false);
    expect(existsSync('dist/python')).toBe(false);
  });

  it('produces sourcemaps', () => {
    expect(existsSync('dist/index.js.map')).toBe(true);
  });

  it('respects bin shebang', () => {
    const content = readFileSync('dist/index.js', 'utf-8');
    expect(content.startsWith('#!')).toBe(true);
  });
});

/*
 * THE EXPORTS MAP, RESOLVED AGAINST THE BUILT `dist/`.
 *
 * Every subpath in `exports` points into `dist/`, and until now nothing core-side checked that
 * any of them lands on a file. A layout change — a renamed entry point, a tsup `entry` edit, a
 * subpath added to the manifest but not to the build — goes green here and reds weeks later at
 * the studio repo's next pin bump, where it reads as a studio problem.
 *
 * The consumer-side probe (wigolo-studio's CI) resolves seven specifiers with
 * `import.meta.resolve`. That is the right shape THERE — it proves the installed dependency
 * exposes what the app imports — but it cannot see a broken path: since Node 20 the ESM
 * resolver does not stat the target, so `import.meta.resolve('wigolo/config')` happily returns
 * a `dist/config.js` that does not exist. Catching that is the producing side's job, so this
 * probe does both halves: resolve through the map, then require the file to be there.
 *
 * Resolution runs in a child ESM process rather than in-test because that is how a consumer
 * resolves — the exports map with the `import` condition, not vitest's resolver. No subpath
 * declares a `require` condition, so a CJS probe would answer ERR_PACKAGE_PATH_NOT_EXPORTED on
 * a perfectly healthy tree.
 */
describe('exports map resolves against the built dist/', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    name: string;
    exports: Record<string, string | Record<string, string>>;
  };

  const specifierFor = (subpath: string) =>
    subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`;

  /** Every file the manifest promises, flattened: `import` targets and `types` targets alike. */
  const targets = Object.entries(pkg.exports).flatMap(([subpath, value]) =>
    (typeof value === 'string' ? [['default', value] as const] : Object.entries(value)).map(
      ([condition, target]) => ({ subpath, condition, target })
    )
  );

  it('promises a non-trivial surface, so an emptied map cannot pass silently', () => {
    // The two assertions below iterate. Over an empty list they both pass and say nothing.
    expect(targets.length).toBeGreaterThanOrEqual(9);
  });

  it('every declared target exists in dist/', () => {
    const missing = targets
      .filter(({ target }) => !existsSync(join(ROOT, target)))
      .map(({ subpath, condition, target }) => `${subpath} [${condition}] -> ${target}`);
    expect(missing).toEqual([]);
  });

  it('every subpath resolves through the map as ESM, the way a consumer resolves it', () => {
    const specifiers = Object.keys(pkg.exports).map(specifierFor);
    const probe = `
      const failures = [];
      for (const s of ${JSON.stringify(specifiers)}) {
        try { await import.meta.resolve(s); } catch (e) { failures.push(s + ': ' + e.code); }
      }
      console.log(JSON.stringify(failures));
    `;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(JSON.parse(stdout.trim())).toEqual([]);
  }, 30_000);

  it('still exposes every specifier the studio app imports', () => {
    // Mirrors wigolo-studio's CI probe. Listed literally rather than derived, because the point
    // is to red HERE when core drops one — a derived list would just shrink with the manifest
    // and agree with it. Growing the map is fine; losing one of these is a consumer break.
    const consumerSpecifiers = [
      'wigolo/studio',
      'wigolo/studio-db-broker',
      'wigolo/cache/db',
      'wigolo/config',
      'wigolo/studio/run-store',
      'wigolo/studio/run-bus',
      'wigolo/studio-mcp-contract',
    ];
    const declared = Object.keys(pkg.exports).map(specifierFor);
    expect(declared).toEqual(expect.arrayContaining(consumerSpecifiers));
  });
});
