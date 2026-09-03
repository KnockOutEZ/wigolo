import { linkSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { allowNetworkInThisFile } from './net-fence.js';

/**
 * Rescue the embedding-model cache into the throwaway test home, the same way the harness
 * already rescues the browser engine's download registry.
 *
 * THE DEFECT THIS CLOSES. `tests/setup.ts` repoints HOME (and `WIGOLO_DATA_DIR`) at a fresh
 * `mkdtemp` home, and the embedder resolves its cache as `${dataDir}/fastembed` — so every test
 * home starts with no model. Under `isolate: true` vitest's forks pool starts a FRESH PROCESS,
 * and therefore a fresh home, for every test FILE, so the first embed in each embedding file
 * cold-downloads BGE-small (~128 MB) inside an individual test's timeout budget. Measured at the
 * PX1 exit rounds: `tests/unit/search/find-similar.test.ts > "still crawls when include_web is
 * true"` timed out at exactly 20s and `tests/integration/rest-tools.test.ts > "find_similar ->
 * 200 with results[]"` at exactly 60s on a slow network, while the SAME SHA was green the same
 * morning on a fast one. Pass/fail rode on the link to the model host, not on the code.
 *
 * WHY HARD LINKS AND NOT A SYMLINK. A symlink at `<TEST_HOME>/.wigolo/fastembed` pointing at
 * `<REAL_HOME>/.wigolo/fastembed` would make a path inside the harness home RESOLVE INTO the
 * developer's real data dir — the exact invariant `tests/unit/harness/data-dir-isolation.test.ts`
 * exists to defend, and the fastembed provider would then create its partial downloads there. A
 * hard-link mirror shares the model's BYTES (no 128 MB copy, no second inode) while every path,
 * every newly created file and every directory removal stays inside the throwaway tree. The one
 * residual — a truncating write THROUGH a link would reach the real bytes — cannot occur: the
 * provider only downloads when the model is absent, and it is absent only when there was nothing
 * to seed from. `resetFastembedCacheDir` removes the mirror's directory entries and leaves the
 * source untouched, which is pinned by a row in `tests/unit/harness/model-cache-seed.test.ts`.
 *
 * WHY IT IS A SEED AND NOT A DEPENDENCY. On a machine with no `~/.wigolo/fastembed` at all — a
 * true cold checkout, and every fresh CI runner — there is nothing to link and the harness must
 * still work with the network available. So a failed or impossible seed is not an error: it
 * publishes `VITEST_WIGOLO_MODEL_CACHE_SEEDED=0` and the download path stands exactly as before.
 *
 * WHAT MAKES THE FIX FALSIFIABLE. The published flag is what arms the network fence in the files
 * whose ONLY egress was this download: when the cache is seeded, `allowModelDownloadWhenUnseeded`
 * does NOT register an allowance, so any connection attempt to the model host reds the file. The
 * suite therefore proves on every run that the download is gone, rather than measuring how fast
 * the runner's link is. `VITEST_WIGOLO_MODEL_SEED=force-cold` forces the condition deliberately
 * (fence armed, cache absent) and is the arm that reds on base and greens on tip.
 *
 * NOT A `WIGOLO_*` NAME, deliberately: that namespace is product config, and a spawned child must
 * never inherit harness state as if it were.
 */

/** Values: `auto` (default) · `off` · `force-cold`. See `readSeedMode`. */
export const MODEL_SEED_MODE_ENV = 'VITEST_WIGOLO_MODEL_SEED';

/** Published by the harness as `'1'` / `'0'`. Read it through `modelCacheIsSeeded()`. */
export const MODEL_CACHE_SEEDED_ENV = 'VITEST_WIGOLO_MODEL_CACHE_SEEDED';

/** The embedder's cache directory name under a data dir — see `ensureFastembedCacheDir`. */
const CACHE_DIR_NAME = 'fastembed';

export type SeedMode =
  /** Seed when the machine has a model to seed from. The default. */
  | 'auto'
  /** Simulate a cold MACHINE: no seed, and the fence stays open so the download may proceed. */
  | 'off'
  /** Simulate a cold NETWORK: no seed, but the fence is armed anyway, so an attempted download
   *  reds the test that attempts it. This is the forced-cold control. */
  | 'force-cold';

export type SeedOutcome =
  | 'seeded'
  | 'already-present'
  /** Nothing to link from — a cold machine. The download path stands. */
  | 'no-source'
  /** The link failed (a cross-device `$TMPDIR`, a read-only source). Same fallback as no-source. */
  | 'failed'
  /** `off` or `force-cold` asked for no seed. */
  | 'skipped';

export interface SeedDecision {
  mode: SeedMode;
  outcome: SeedOutcome;
  /** Whether the fence may be armed — i.e. whether a download is expected to be unnecessary. */
  seeded: boolean;
}

/** Where a real install keeps its model cache. Must be read BEFORE the harness repoints HOME. */
export function realModelCacheDir(realHome: string): string {
  return join(realHome, '.wigolo', CACHE_DIR_NAME);
}

/**
 * Deliberately model-name agnostic: "there is something cached here", not "BGE-small is cached
 * here". The provider picks the model, and a name pinned in the harness would silently stop
 * seeding — reverting to the download — the day the model changes.
 */
function dirHasContent(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Mirror `src` into `dest` as hard links. Directories are recreated; files share their inode. */
function mirrorWithHardLinks(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      mirrorWithHardLinks(from, to);
    } else if (entry.isFile()) {
      linkSync(from, to);
    }
    // Anything else (a symlink, a socket) is skipped rather than followed: a model cache holds
    // regular files, and following a link here would reintroduce the escape the mirror avoids.
  }
}

/**
 * Link the real model cache into `${dataDir}/fastembed`. Pure over its two paths, so the
 * containment claims above are tested without touching the developer's real home.
 */
export function seedModelCache(realCache: string, dataDir: string): SeedOutcome {
  const target = join(dataDir, CACHE_DIR_NAME);
  if (dirHasContent(target)) return 'already-present';
  if (!dirHasContent(realCache)) return 'no-source';
  try {
    mirrorWithHardLinks(realCache, target);
    return 'seeded';
  } catch {
    // A half-built mirror would look "already-present" to the next call while missing the file
    // the provider needs. Removing it only unlinks entries inside the target tree.
    rmSync(target, { recursive: true, force: true });
    return 'failed';
  }
}

export function readSeedMode(env: NodeJS.ProcessEnv = process.env): SeedMode {
  const raw = env[MODEL_SEED_MODE_ENV];
  return raw === 'off' || raw === 'force-cold' ? raw : 'auto';
}

/**
 * Run the seed for this process and publish the result. Takes `env` so the decision — including
 * `force-cold`'s deliberate divergence between "seeded" and "a cache exists" — is asserted
 * against a fake environment rather than by mutating the running suite's own.
 */
export function installModelCacheSeed(
  realCache: string,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SeedDecision {
  const mode = readSeedMode(env);
  const outcome = mode === 'auto' ? seedModelCache(realCache, dataDir) : 'skipped';
  // `force-cold` claims a seed it did not perform. That is the whole point of the mode: it puts
  // the suite in the state "no model in the test home AND no allowance to fetch one", which is
  // what a machine that cannot reach the model host looks like.
  const seeded = mode === 'force-cold' || outcome === 'seeded' || outcome === 'already-present';
  env[MODEL_CACHE_SEEDED_ENV] = seeded ? '1' : '0';
  return { mode, outcome, seeded };
}

export function modelCacheIsSeeded(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MODEL_CACHE_SEEDED_ENV] === '1';
}

/**
 * Declare the model download as this file's egress ONLY on a machine that had nothing to seed
 * from. On every other machine the fence stays armed, so a regression that reintroduces the
 * download fails the file instead of quietly making it slow again.
 *
 * Use this in place of `allowNetworkInThisFile` only where the model download is the file's
 * SOLE egress. A file that also reaches live search engines keeps its unconditional allowance.
 */
export function allowModelDownloadWhenUnseeded(reason: string): void {
  if (modelCacheIsSeeded()) return;
  allowNetworkInThisFile(reason);
}
