import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/*
 * Subpath exports for the companion split (EXTRACT A4, spec §3).
 *
 * The private `packages/studio-core` consumes core through these subpaths only, so a
 * missing or mis-targeted one dead-ends the extraction. Two things are asserted, and
 * BOTH are needed: the declared target, and a REAL `import()` of the specifier in a
 * child Node process. `import.meta.resolve` does not stat — it happily returns a URL
 * for a target that does not exist on disk, so a resolve-only probe is green against a
 * broken `dist/` path. The child process also keeps the probe on Node's own ESM
 * resolver rather than the test runner's.
 *
 * The runtime key sets are PINNED to what `src/studio/**` and the app measurably import
 * (measured 2026-09-02). They are a ceiling, not a floor: a barrel that grows a symbol
 * nobody measured widens the public surface of a repo whose whole point here is to
 * shrink it, and that reds here.
 */

const repoRoot = join(__dirname, '..', '..');

interface Subpath {
  /** The `wigolo/...` specifier the private package imports. */
  spec: string;
  /** Exact `exports` map target, both conditions. */
  target: string;
  /** Every runtime (non-type) name the subpath is allowed to expose. */
  runtime: string[];
}

const SUBPATHS: Subpath[] = [
  {
    spec: 'wigolo/security',
    target: './dist/security/index.js',
    runtime: [
      'UNTRUSTED_STUDIO_NOTICE',
      'decryptFromFile',
      'encryptToFile',
      'guardNavigation',
      'keychainAvailable',
      'keychainGet',
      'keychainSet',
      'neutralizeMarkers',
    ],
  },
  {
    spec: 'wigolo/fetch-tiers',
    target: './dist/fetch/index.js',
    runtime: ['classifyChallenge', 'isChallengeShell', 'requireBrowserDriver'],
  },
  {
    spec: 'wigolo/cache',
    target: './dist/cache/index.js',
    runtime: ['normalizeUrl', 'sanitizeFtsQuery'],
  },
  {
    spec: 'wigolo/embedding-queue',
    target: './dist/embedding/index.js',
    runtime: ['getBackgroundIndexQueue'],
  },
  {
    spec: 'wigolo/search-tokens',
    target: './dist/search/index.js',
    runtime: ['countTokens'],
  },
  {
    // A single module, exported directly like `./config` and `./cache/db` — the same
    // shape core already ships for a one-file surface. The key set is pinned anyway, so
    // a new export in `logger.ts` forces the barrel question rather than leaking.
    spec: 'wigolo/logger',
    target: './dist/logger.js',
    runtime: ['createLogger', 'getLogSuppression', 'setLogSuppression'],
  },
  {
    // The app boots the embedded gateway and drives it with the bearer client; both point
    // at daemon modules that STAY in core. Today it reaches them through the `wigolo/studio`
    // barrel, which Phase C deletes.
    spec: 'wigolo/daemon',
    target: './dist/daemon/index.js',
    runtime: ['DaemonHttpServer', 'DaemonProxy'],
  },
  {
    // The kept companion integration layer (EXTRACT A5, spec §2.2). Of the eleven kept
    // files only `paths.ts` has a private-side consumer — `run-store.ts`,
    // `profile-store.ts` and `perception/spill.ts` all resolve their on-disk state
    // through `studioStateDir`, and every other kept file's consumers are core's own
    // seams (daemon, cli, fetch, config), which import the module directly. So the
    // ceiling here is one symbol; a second one appearing means a kept file grew a
    // private-side consumer and that is a question, not a detail.
    spec: 'wigolo/companion',
    target: './dist/companion/index.js',
    runtime: ['studioStateDir'],
  },
  {
    spec: 'wigolo/companion-contract',
    target: './dist/companion-contract/index.js',
    runtime: [
      'BROKER_REFUSAL_REASONS',
      'BROKER_REVOCATION_REASONS',
      'BROKER_TABLES',
      'BROKER_WRITE_KINDS',
      'COMPANION_CONTRACT_VERSION',
      'ESCALATION_DECLINE_REASONS',
      'RESEARCHABLE_TYPES',
      'SESSION_TARGET_OPS',
      'SESSION_TARGET_REFUSAL_REASONS',
      'STUDIO_EMBED_PREFIX',
      'STUDIO_FETCH_CAPABILITY',
      'evaluateHandshake',
      'grantCovers',
      'isBrokerRefusal',
      'isEscalationDecline',
      'isEscalationServed',
      'isResearchableArtifactType',
      'isSessionTargetRefusal',
      'isSessionTargeted',
      'isStudioEmbedKey',
      'makeStudioEmbedKey',
      'parseStudioEmbedKey',
    ],
  },
];

interface ExportsMap {
  [subpath: string]: string | { import?: string; types?: string };
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
  exports: ExportsMap;
};

interface ProbeOk {
  resolved: string;
  keys: string[];
}
interface ProbeErr {
  error: string;
}
type ProbeResult = ProbeOk | ProbeErr;

const SENTINEL = '<<<WIGOLO_EXPORT_PROBE>>>';

let probe: Record<string, ProbeResult> = {};

beforeAll(() => {
  const specs = SUBPATHS.map((s) => s.spec);
  const source = `
const specs = ${JSON.stringify(specs)};
const out = {};
for (const spec of specs) {
  try {
    const resolved = import.meta.resolve(spec);
    const mod = await import(spec);
    out[spec] = { resolved, keys: Object.keys(mod).sort() };
  } catch (err) {
    out[spec] = { error: String((err && err.message) || err) };
  }
}
process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(out));
`;
  // Self-reference (`wigolo/...` resolving against this package's own `exports`) needs a
  // resolution base inside the package, which `--input-type=module -e` takes from cwd.
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const marker = stdout.indexOf(SENTINEL);
  expect(marker, `probe produced no result:\n${stdout}`).toBeGreaterThanOrEqual(0);
  probe = JSON.parse(stdout.slice(marker + SENTINEL.length)) as Record<string, ProbeResult>;
}, 120_000);

describe('npm subpath exports for the companion split', () => {
  for (const { spec, target, runtime } of SUBPATHS) {
    const subpath = `.${spec.slice('wigolo'.length)}`;

    it(`${spec} is declared at ${target} with types beside it`, () => {
      const entry = pkg.exports[subpath];
      expect(entry, `package.json exports is missing "${subpath}"`).toBeDefined();
      const resolvedTarget = typeof entry === 'string' ? entry : entry?.import;
      expect(resolvedTarget).toBe(target);
      if (typeof entry !== 'string') {
        expect(entry?.types).toBe(target.replace(/\.js$/, '.d.ts'));
        expect(existsSync(join(repoRoot, entry?.types ?? ''))).toBe(true);
      }
    });

    it(`${spec} really imports and exposes exactly the measured need`, () => {
      const result = probe[spec];
      expect(result, `no probe result for ${spec}`).toBeDefined();
      if ('error' in result) {
        throw new Error(`import('${spec}') failed: ${result.error}`);
      }
      // Pairs the resolve with a stat: a resolver answer alone proves nothing about disk.
      expect(existsSync(fileURLToPath(result.resolved))).toBe(true);
      expect(result.resolved.endsWith(target.slice(1))).toBe(true);
      expect(result.keys).toEqual([...runtime].sort());
    });
  }

  it('keeps every export target inside dist/', () => {
    for (const entry of Object.values(pkg.exports)) {
      const t = typeof entry === 'string' ? entry : entry.import;
      expect(t?.startsWith('./dist/')).toBe(true);
    }
  });
});
