import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  MODEL_CACHE_SEEDED_ENV,
  MODEL_SEED_MODE_ENV,
  installModelCacheSeed,
  readSeedMode,
  realModelCacheDir,
  seedModelCache,
} from '../../model-cache.js';

/**
 * Falsifiability probe for the embedding-model seed (issue #241).
 *
 * The claim under test is NOT "setup.ts calls the seed" — an assertion on the call cannot fail
 * when the behaviour regresses, because a seed that silently returns `no-source`, or one that
 * runs after HOME has already moved, calls exactly the same function and leaves the download in
 * place. So the rows below assert OUTCOMES: bytes shared rather than copied, the source
 * surviving the mirror's removal, and — on this machine, right now — the running harness's own
 * data dir actually holding a model.
 *
 * The forced-cold row matters for the same reason. `force-cold` is the control the fix is proved
 * with, and a control that quietly does nothing would make the arm pass vacuously; the row pins
 * that it reports a seed while deliberately leaving the cache absent.
 */

const scratch: string[] = [];

function tempTree(): { source: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'wigolo-model-seed-'));
  scratch.push(root);
  return { source: join(root, 'source'), dataDir: join(root, 'data') };
}

/** A stand-in for the model cache: a model directory holding a file with known bytes. */
function seedSource(source: string, bytes = 'onnx-bytes'): string {
  const modelDir = join(source, 'fast-bge-small-en-v1.5');
  mkdirSync(modelDir, { recursive: true });
  const file = join(modelDir, 'model_optimized.onnx');
  writeFileSync(file, bytes);
  return file;
}

describe('test harness -- embedding model cache seed', () => {
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports no-source and creates nothing when the machine has no model cache', () => {
    const { source, dataDir } = tempTree();
    mkdirSync(dataDir, { recursive: true });

    expect(seedModelCache(source, dataDir)).toBe('no-source');
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('treats an empty cache the same as a missing one', () => {
    const { source, dataDir } = tempTree();
    mkdirSync(source, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    expect(seedModelCache(source, dataDir)).toBe('no-source');
  });

  it('seeds by hard link, not by copy — the mirror shares the source inode', () => {
    // The whole reason this is affordable per test FILE (~790 of them) is that no bytes move.
    // A copy would pass a "the file is there" assertion while costing 128 MB per process, so the
    // inode is the claim, not the file's existence.
    const { source, dataDir } = tempTree();
    const file = seedSource(source);
    mkdirSync(dataDir, { recursive: true });

    expect(seedModelCache(source, dataDir)).toBe('seeded');

    const mirrored = join(dataDir, 'fastembed', 'fast-bge-small-en-v1.5', 'model_optimized.onnx');
    expect(readFileSync(mirrored, 'utf8')).toBe('onnx-bytes');
    expect(statSync(mirrored).ino).toBe(statSync(file).ino);
  });

  it('removing the mirror leaves the real cache intact', () => {
    // This is the containment claim that rules out a symlink. The embedder's own corrupt-archive
    // recovery calls `resetFastembedCacheDir`, which removes `${dataDir}/fastembed` outright — a
    // symlink would have made that a recursive delete of the developer's real model cache.
    const { source, dataDir } = tempTree();
    const file = seedSource(source);
    mkdirSync(dataDir, { recursive: true });
    expect(seedModelCache(source, dataDir)).toBe('seeded');

    rmSync(join(dataDir, 'fastembed'), { recursive: true, force: true });

    expect(readFileSync(file, 'utf8')).toBe('onnx-bytes');
  });

  it('is idempotent — a second call reports already-present rather than relinking', () => {
    const { source, dataDir } = tempTree();
    seedSource(source);
    mkdirSync(dataDir, { recursive: true });

    expect(seedModelCache(source, dataDir)).toBe('seeded');
    expect(seedModelCache(source, dataDir)).toBe('already-present');
  });

  it('defaults to auto, and reads only the two modes it defines', () => {
    expect(readSeedMode({})).toBe('auto');
    expect(readSeedMode({ [MODEL_SEED_MODE_ENV]: 'off' })).toBe('off');
    expect(readSeedMode({ [MODEL_SEED_MODE_ENV]: 'force-cold' })).toBe('force-cold');
    expect(readSeedMode({ [MODEL_SEED_MODE_ENV]: 'yes' })).toBe('auto');
  });

  it('auto publishes seeded=1 when it linked a cache, and 0 when there was none', () => {
    const warm = tempTree();
    seedSource(warm.source);
    mkdirSync(warm.dataDir, { recursive: true });
    const warmEnv: NodeJS.ProcessEnv = {};
    expect(installModelCacheSeed(warm.source, warm.dataDir, warmEnv)).toMatchObject({
      mode: 'auto',
      outcome: 'seeded',
      seeded: true,
    });
    expect(warmEnv[MODEL_CACHE_SEEDED_ENV]).toBe('1');

    const cold = tempTree();
    mkdirSync(cold.dataDir, { recursive: true });
    const coldEnv: NodeJS.ProcessEnv = {};
    expect(installModelCacheSeed(cold.source, cold.dataDir, coldEnv)).toMatchObject({
      outcome: 'no-source',
      seeded: false,
    });
    expect(coldEnv[MODEL_CACHE_SEEDED_ENV]).toBe('0');
  });

  it('force-cold reports a seed it did not perform — fence armed, cache absent', () => {
    // The control. If this mode ever started seeding, the forced-cold arm would go green for the
    // wrong reason and would stop being evidence of anything.
    const { source, dataDir } = tempTree();
    seedSource(source);
    mkdirSync(dataDir, { recursive: true });
    const env: NodeJS.ProcessEnv = { [MODEL_SEED_MODE_ENV]: 'force-cold' };

    expect(installModelCacheSeed(source, dataDir, env)).toMatchObject({
      mode: 'force-cold',
      outcome: 'skipped',
      seeded: true,
    });
    expect(env[MODEL_CACHE_SEEDED_ENV]).toBe('1');
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('off leaves the cache absent AND the fence open — a cold machine, network available', () => {
    const { source, dataDir } = tempTree();
    seedSource(source);
    mkdirSync(dataDir, { recursive: true });
    const env: NodeJS.ProcessEnv = { [MODEL_SEED_MODE_ENV]: 'off' };

    expect(installModelCacheSeed(source, dataDir, env)).toMatchObject({
      mode: 'off',
      outcome: 'skipped',
      seeded: false,
    });
    expect(env[MODEL_CACHE_SEEDED_ENV]).toBe('0');
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('the RUNNING harness seeded the data dir of this process, if this machine had a cache', () => {
    // The outside signal. Every row above works on fixtures and would still pass if `setup.ts`
    // never called the seed, or called it after HOME had already moved — the two ways this fix
    // regresses in practice. `userInfo().homedir` reads the password database rather than $HOME,
    // so it still names the real profile after the harness has repointed HOME.
    //
    // Asserted in BOTH directions rather than skipped when there is no cache: a skip here is
    // indistinguishable from a broken seed, and "no cache on this machine" is itself a checkable
    // state with a required consequence (the flag must say 0, so the fence is not armed against
    // a download that genuinely still has to happen).
    const dataDir = process.env.WIGOLO_DATA_DIR;
    expect(dataDir).toBeTruthy();

    const realCache = realModelCacheDir(userInfo().homedir);
    const machineHasCache = (() => {
      try {
        return readdirSync(realCache).length > 0;
      } catch {
        return false;
      }
    })();

    const mirror = join(dataDir as string, 'fastembed');
    const mirrored = (() => {
      try {
        return readdirSync(mirror).length > 0;
      } catch {
        return false;
      }
    })();

    // `force-cold` is the one mode that deliberately breaks the equivalence; it is not in force
    // during an ordinary run and the row states that precondition rather than assuming it.
    if (readSeedMode() === 'auto') {
      expect(mirrored).toBe(machineHasCache);
      expect(process.env[MODEL_CACHE_SEEDED_ENV]).toBe(machineHasCache ? '1' : '0');
    } else {
      expect(mirrored).toBe(false);
    }
  });
});
