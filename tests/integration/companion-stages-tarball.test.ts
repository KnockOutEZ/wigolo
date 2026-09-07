import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * WHY THIS LIVES IN `tests/integration/` AND NOT BESIDE `tests/unit/package-exports.test.ts`.
 *
 * It runs `npm pack`, which runs the packed project's own `prepare` hook, which BUILDS — and
 * tsup's `clean: true` deletes `dist/` before writing anything. `tests/integration/**` is the
 * `spawn-serial` vitest project (one fork, `fileParallelism: false`), which is the only lane
 * where a dist/-rebuilding test cannot delete `dist/` out from under a test that has just
 * spawned it. That rule is asserted in `tests/unit/dist-rebuild-serialization.test.ts`; the
 * same reasoning is written out at the top of `tests/integration/budget-tarball-gate.test.ts`.
 *
 * WHY IT IS NOT REDUNDANT WITH `package-exports.test.ts`. That probe imports every subpath for
 * real, which is what defeats the `import.meta.resolve` trap — resolve does not stat, so a
 * resolve-only check is green against a `dist/` path that does not exist. But it imports from
 * the WORKING TREE, where every file exists whether or not `files` ships it. The failure this
 * one catches is the other half: a subpath whose target is real, importable and simply not in
 * the published tarball, or one whose module pulls in a sibling that is not. The consumer here
 * is a private package installing wigolo from a registry, so the tarball IS its `dist/`.
 *
 * The probe also CALLS the factory. A module can import cleanly and still fail the moment its
 * first line runs — `createExtractStage` constructs a router and a browser pool eagerly — and an
 * assertion that stopped at `typeof === 'function'` would be green through exactly that.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SENTINEL = '<<<WIGOLO_TARBALL_PROBE>>>';

interface ProbeResult {
  keys: string[];
  factory: string;
  stage: string;
  mode: string;
  source_url?: string;
}

describe('wigolo/companion-stages loads from a packed tarball', () => {
  it('publishes createExtractStage where a consuming package can import and call it', () => {
    // Everything below is under the OS temp dir on purpose: nothing is written into, or removed
    // from, the working tree.
    const work = mkdtempSync(join(tmpdir(), 'wigolo-stages-pack-'));
    try {
      // `--pack-destination` into an empty directory rather than parsing `--json` off stdout:
      // the `prepare` hook writes build progress to the same stream, which is what broke the
      // G-TARBALL measurement once already. The directory has exactly one entry afterwards.
      execFileSync('npm', ['pack', '--pack-destination', work], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const tarballs = readdirSync(work).filter((f) => f.endsWith('.tgz'));
      expect(tarballs, `npm pack produced no tarball in ${work}`).toHaveLength(1);

      // npm tarballs unpack to a `package/` root. Installing it as `node_modules/wigolo` is what
      // puts the probe on the package's own `exports` map — a bare path import would bypass it
      // and prove nothing about the subpath.
      execFileSync('tar', ['-xzf', join(work, tarballs[0]), '-C', work], { stdio: 'pipe' });
      const consumer = join(work, 'consumer');
      const consumerModules = join(consumer, 'node_modules');
      mkdirSync(consumerModules, { recursive: true });
      // The tarball carries no `node_modules`, so wigolo's own runtime dependencies are linked in
      // from this repo's tree. They go BESIDE the unpacked package rather than in the consumer's
      // folder because Node resolves a bare specifier by walking up from the IMPORTING file, and
      // the importing files here are the tarball's own `dist/**` — a dependency parked in the
      // consumer's `node_modules` is never on that path.
      //
      // Linking rather than installing is the right factoring, not a shortcut: what is under test
      // is whether the PUBLISHED FILES are complete and reachable through `exports`, not npm's
      // ability to download third-party packages. A missing dependency DECLARATION is a different
      // failure with its own gate (the clean-machine install smoke).
      const packageDeps = join(work, 'node_modules');
      mkdirSync(packageDeps, { recursive: true });
      for (const dep of readdirSync(join(REPO_ROOT, 'node_modules'))) {
        if (dep.startsWith('.') || dep === 'wigolo') continue;
        symlinkSync(join(REPO_ROOT, 'node_modules', dep), join(packageDeps, dep), 'dir');
      }
      symlinkSync(join(work, 'package'), join(consumerModules, 'wigolo'), 'dir');
      writeFileSync(
        join(consumer, 'package.json'),
        JSON.stringify({ name: 'stages-probe', version: '0.0.0', type: 'module', private: true }),
      );

      const probeSource = `
const mod = await import('wigolo/companion-stages');
const stage = mod.createExtractStage();
const out = await stage({
  html: '<html><head><title>Packed</title></head><body><h1>Packed</h1></body></html>',
  mode: 'metadata',
  source_url: 'https://packed.example/page',
});
process.stdout.write('${SENTINEL}' + JSON.stringify({
  keys: Object.keys(mod).sort(),
  factory: typeof mod.createExtractStage,
  stage: typeof stage,
  mode: out.mode,
  source_url: out.source_url,
  title: out.data && out.data.title,
}));
`;
      writeFileSync(join(consumer, 'probe.mjs'), probeSource);
      const stdout = execFileSync(process.execPath, ['probe.mjs'], {
        cwd: consumer,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      const marker = stdout.indexOf(SENTINEL);
      expect(marker, `probe produced no result:\n${stdout}`).toBeGreaterThanOrEqual(0);
      const result = JSON.parse(stdout.slice(marker + SENTINEL.length)) as ProbeResult & {
        title?: string;
      };

      expect(result.keys).toContain('createExtractStage');
      expect(result.keys).toContain('ExtractStageError');
      expect(result.factory).toBe('function');
      expect(result.stage).toBe('function');
      // Ran, not merely imported: a real extraction came back out of the packed module.
      expect(result.mode).toBe('metadata');
      expect(result.title).toBe('Packed');
      expect(result.source_url).toBe('https://packed.example/page');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 300_000);
});
