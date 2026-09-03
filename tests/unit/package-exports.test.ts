import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

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
 * The runtime key sets are PINNED to what the extracted domain layer and the app measurably
 * import (measured 2026-09-02, against `src/studio/**` while it was still here). They are a
 * ceiling, not a floor: a barrel that grows a symbol nobody measured widens the public surface of
 * a repo whose whole point here is to shrink it, and that reds here.
 *
 * A type-only export is INVISIBLE to the runtime probe — `Object.keys` of the imported
 * module never sees it, so dropping one from a barrel is silent there. The barrels A6
 * widened therefore also pin `types`, asserted against the exported-name set of the
 * EMITTED `.d.ts` (parsed, not grepped): that is the artifact the `types` condition of
 * the exports map actually resolves to, so a symbol missing from the barrel source is
 * missing from it too. `wigolo/fetch-tiers` gains nothing but a type at A6, so without
 * this half that whole widening would be unpinned.
 */

const repoRoot = join(__dirname, '..', '..');

interface Subpath {
  /** The `wigolo/...` specifier the private package imports. */
  spec: string;
  /** Exact `exports` map target, both conditions. */
  target: string;
  /** Every runtime (non-type) name the subpath is allowed to expose. */
  runtime: string[];
  /**
   * Every type-only name the subpath is allowed to expose. Present only for the barrels
   * whose type surface is pinned; `undefined` means "not pinned here", not "none".
   */
  types?: string[];
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
    // `ClearanceCookie` is the shape a solved challenge hands back to
    // `human-solve-bridge.ts`; it is this subpath's entire A6 widening and is type-only.
    spec: 'wigolo/fetch-tiers',
    target: './dist/fetch/index.js',
    runtime: ['classifyChallenge', 'isChallengeShell', 'requireBrowserDriver'],
    types: ['ClearanceCookie'],
  },
  {
    spec: 'wigolo/cache',
    target: './dist/cache/index.js',
    runtime: [
      'getAuthenticatedCorpusStats',
      'normalizeUrl',
      'purgeAuthenticatedCorpus',
      'sanitizeFtsQuery',
    ],
    types: [
      'AuthenticatedCorpusPurgeOptions',
      'AuthenticatedCorpusPurgeResult',
      'AuthenticatedCorpusStats',
      'ArtifactProvider',
      'ArtifactRecord',
    ],
  },
  {
    // A7 adds the class and the test reset beside the singleton. The factory is not a
    // substitute: it hard-codes `dbPath`, `syncMode` and `maxAttempts` and takes no provider,
    // so the extracted layer's constructor-injected specs cannot reach it, and without the
    // reset hook two of them share one cached singleton over one db file.
    // `_resetBackgroundIndexQueueForTest` is test support published on purpose — pinning it
    // here is what makes that a decision rather than an accident.
    spec: 'wigolo/embedding-queue',
    target: './dist/embedding/index.js',
    runtime: [
      'BackgroundIndexQueue',
      '_resetBackgroundIndexQueueForTest',
      'getBackgroundIndexQueue',
    ],
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
    // The app boots the embedded gateway and drives it with the bearer client; both point at
    // daemon modules that STAY in core. This subpath is how it reaches them now that the
    // `wigolo/studio` barrel it used to go through is gone.
    spec: 'wigolo/daemon',
    target: './dist/daemon/index.js',
    runtime: ['DaemonHttpServer', 'DaemonProxy'],
  },
  {
    // The kept companion integration layer (EXTRACT A5, spec §2.2). A4 sized this from a
    // measurement of `src/studio/**` that came out one symbol wide (`studioStateDir`);
    // B1 then copied the domain layer into `packages/studio-core`, rewrote its imports
    // onto these subpaths, and the compiler enumerated ten more that the layer measurably
    // imports. A6 widened the barrel to exactly that enumeration plus the handle +
    // `resolveHostToken` set D1's switch table sends here now that `wigolo/studio` is deleted.
    // A7 adds the two origin-budget defaults: the gate's own spec asserts against them, and
    // the only other door to them was `wigolo/studio`, which loaded a second `OriginBudget`
    // beside the one under test and booted the engine at import time.
    // Still a ceiling: each name below has a named import site outside core. Daemon-route
    // auth (`checkAuth`, `checkAuthSubprotocol`, `checkOriginHost`) is deliberately out —
    // core imports it directly and nothing outside core reaches for it.
    spec: 'wigolo/companion',
    target: './dist/companion/index.js',
    runtime: [
      'DEFAULT_ANONYMOUS_ORIGIN_BUDGET',
      'DEFAULT_ORIGIN_BUDGET',
      'OriginBudget',
      'budgetOrigin',
      'budgetRefusal',
      'getMyInstanceId',
      'mintHostToken',
      'normalizeOrigin',
      'readHandle',
      'removeHandle',
      'resolveHostToken',
      'setMyInstanceId',
      'studioHandlePath',
      'studioStateDir',
      'writeHandle',
    ],
    types: [
      'AuthenticatedOriginOverrides',
      'EscalationCounterKey',
      'OriginBudgetVerdict',
      'OriginClass',
      'SessionHandle',
    ],
  },
  {
    spec: 'wigolo/companion-contract',
    target: './dist/companion-contract/index.js',
    runtime: [
      'BROKER_REFUSAL_REASONS',
      'BROKER_REVOCATION_REASONS',
      'BROKER_ROUTE',
      'BROKER_TABLES',
      'BROKER_WRITE_KINDS',
      'COMPANION_CONTRACT_VERSION',
      'ESCALATION_DECLINE_REASONS',
      'ESCALATION_ROUTE',
      'MAX_BROKER_ROWS',
      'PAIRING_ROUTE',
      'RESEARCHABLE_TYPES',
      'SESSION_TARGET_OPS',
      'SESSION_TARGET_REFUSAL_REASONS',
      'SESSION_TARGET_ROUTE',
      'STUDIO_EMBED_PREFIX',
      'STUDIO_FETCH_CAPABILITY',
      'evaluateHandshake',
      'grantCovers',
      'isBrokerRefusal',
      'isEscalationDecline',
      'isEscalationServed',
      'isHandshakeRefusal',
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

/**
 * Every name the emitted declaration file exports, parsed with the compiler's own parser
 * rather than matched with a regex — a substring match would call `OriginBudget` present
 * because `OriginBudgetVerdict` is. Both emit shapes count: a re-export specifier
 * (`export { x, type Y } from './m.js'`, which is what a barrel emits) and a declaration
 * carrying the `export` modifier (what a single-module target emits).
 */
function declaredExportNames(dtsPath: string): string[] {
  const text = readFileSync(dtsPath, 'utf-8');
  const sf = ts.createSourceFile(dtsPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) names.add(el.name.text);
      } else if (st.exportClause && ts.isNamespaceExport(st.exportClause)) {
        names.add(st.exportClause.name.text);
      } else {
        // `export * from ...` — a star re-export makes the pinned set unenforceable,
        // which is the opposite of a ceiling, so refuse it outright.
        throw new Error(`${dtsPath} uses a star re-export; the pinned surface cannot be enforced`);
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
    if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name
    ) {
      names.add(st.name.text);
    }
  }
  return [...names].sort();
}

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
  for (const { spec, target, runtime, types } of SUBPATHS) {
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

    if (types) {
      it(`${spec} publishes exactly the measured type surface in its .d.ts`, () => {
        const entry = pkg.exports[subpath];
        const dts = typeof entry === 'string' ? undefined : entry?.types;
        expect(dts, `no types condition for ${subpath}`).toBeDefined();
        // The runtime probe cannot see a type, so this half is what makes dropping one red.
        expect(declaredExportNames(join(repoRoot, dts as string))).toEqual(
          [...runtime, ...types].sort(),
        );
      });
    }
  }

  it('keeps every export target inside dist/', () => {
    for (const entry of Object.values(pkg.exports)) {
      const t = typeof entry === 'string' ? entry : entry.import;
      expect(t?.startsWith('./dist/')).toBe(true);
    }
  });
});
