import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allowNetworkInThisFile } from '../../net-fence.js';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { harvestTarget } from '../../../scripts/binary/harvest.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { readManifest } from '../../../scripts/binary/manifest.mjs';

/*
 * The one LIVE arm: opt-in, host-target only.
 *
 * WHY IT IS OPT-IN. It measures UPSTREAM — six registries and a GitHub release — so on a
 * normal run it would report other people's outages as our red, which is exactly the shape
 * `tests/net-fence.ts` exists to prevent. Set `WIGOLO_BINARY_HARVEST_LIVE=1` to run it.
 *
 * WHY IT EXISTS AT ALL, given the offline arms cover every refusal path. The offline arms
 * prove the DECISIONS; only this one proves the URLs are real and the bytes are loadable.
 * Every one of the six natives has a different publication scheme, and a per-target package
 * spelling nothing here can verify by reasoning: `sqlite-vec-windows-x64` where every other
 * native says win32, napi triples for keyring and wreq-js, the ABI in better-sqlite3's asset
 * name. Each of those 404s indistinguishably from "upstream published no prebuild", and under
 * refuse-don't-compile a false refusal blocks a whole target.
 *
 * AND WHY IT LOADS THE BINDING RATHER THAN STATTING IT. A staged file only proves a download.
 * The gate that matters is the mini-spec §2 M2 one: the harvested `better-sqlite3` opens a
 * database and the harvested `sqlite-vec` answers a query THROUGH it. That is the assertion a
 * wrong-ABI prebuild fails while every existence check passes.
 */
allowNetworkInThisFile(
  'harvests the real prebuilt natives from npm and the better-sqlite3 GitHub release; the URLs and ' +
    'the loadability of the bytes cannot be verified against a stub. Opt-in via WIGOLO_BINARY_HARVEST_LIVE=1.'
);

const LIVE = process.env.WIGOLO_BINARY_HARVEST_LIVE === '1';
const HOST_TARGET = `${process.platform}-${process.arch}`;

let stageRoot: string | null = null;

afterAll(() => {
  if (stageRoot) rmSync(stageRoot, { recursive: true, force: true });
});

describe.skipIf(!LIVE)(`live harvest of ${HOST_TARGET}`, () => {
  it(
    'stages every non-optional cell, and the harvested database driver opens and queries',
    async () => {
      const manifest = readManifest();
      expect(manifest.targets, `${HOST_TARGET} is not a ship target; this arm only runs on one`).toContain(HOST_TARGET);
      const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));

      stageRoot = mkdtempSync(join(tmpdir(), 'wigolo-harvest-live-'));
      const doc = await harvestTarget({ manifest, lock, target: HOST_TARGET, stageRoot });

      const refused = doc.cells.filter((c: { status: string; optional: boolean }) => c.status !== 'staged' && !c.optional);
      expect(refused).toEqual([]);

      // Every staged cell carries at least one loadable object, and an upstream digest was
      // verified for everything except better-sqlite3, whose release assets publish none.
      for (const cell of doc.cells) {
        if (cell.status !== 'staged') continue;
        expect(cell.payload.length, cell.id).toBeGreaterThan(0);
        expect(cell.source.integrityVerified, cell.id).toBe(cell.source.kind === 'npm-tarball');
      }

      // The M2 gate, on the harvested bytes rather than on node_modules'.
      const binding = join(stageRoot, 'libexec/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
      expect(existsSync(binding)).toBe(true);
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(':memory:', { nativeBinding: binding });
      try {
        expect(db.prepare('SELECT sqlite_version() AS v').get()).toHaveProperty('v');

        const vecCell = doc.cells.find((c: { native: string }) => c.native === 'sqlite-vec');
        const vecPath = join(stageRoot, 'libexec', vecCell.stageTo, vecCell.payload[0].path);
        db.loadExtension(vecPath);
        // vec_version comes from the extension itself, so this cannot pass if the loaded
        // library is the wrong architecture or a stale copy.
        const reported = (db.prepare('SELECT vec_version() AS v').get() as { v: string }).v;
        expect(reported).toContain(vecCell.version);
      } finally {
        db.close();
      }

      // And the objects are for the target we asked for, not the host's node_modules copy.
      if (process.platform === 'darwin') {
        const described = execFileSync('file', ['-b', binding], { encoding: 'utf8' });
        expect(described).toContain(process.arch);
      }
    },
    600_000
  );
});
