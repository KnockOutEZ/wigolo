import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A private data dir, claimed at MODULE LOAD so it is set before any wigolo module is imported.
 *
 * A spec that boots a real daemon in the test process cannot do this in `beforeAll`: `getConfig()`
 * caches on first call, ES module imports are evaluated before any test hook runs, and importing
 * `wigolo/studio` is enough to trigger that first call. Setting `WIGOLO_DATA_DIR` in `beforeAll`
 * therefore lands too late and the daemon opens the DEVELOPER'S OWN `~/.wigolo/wigolo.db` — writing
 * test runs into their real library and reading other machines' runs back as if they were the app's.
 *
 * Import this FIRST, above every `wigolo/*` import. The specs that use it also assert the daemon
 * starts with an empty run list, so a future import reorder reds a test instead of silently
 * reaching for the real data dir again.
 */
export const ISOLATED_DATA_DIR = mkdtempSync(join(tmpdir(), 'wigolo-studio-e2e-data-'));

process.env.WIGOLO_DATA_DIR = ISOLATED_DATA_DIR;
delete process.env.WIGOLO_API_TOKEN;
delete process.env.WIGOLO_API_TOKEN_FILE;
