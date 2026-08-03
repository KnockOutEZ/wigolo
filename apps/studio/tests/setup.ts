import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point every app unit test at a throwaway data dir.
 *
 * Found while wiring S9's authenticated-origin ledger: the host resolves its data dir from
 * `WIGOLO_DATA_DIR` (falling back to `~/.wigolo`), so an app unit test that exercised a host path was
 * READING and WRITING the developer's real profile — and a stale entry in the real ledger then changed the
 * verdict of an unrelated test. Tests that depend on, or mutate, the machine they run on are not tests.
 *
 * Assigned as an env var rather than via a module import so it is in place before any module that resolves
 * config at import time — a static import here would hoist above the assignment.
 */
process.env.WIGOLO_DATA_DIR = mkdtempSync(join(tmpdir(), 'wigolo-studio-test-'));
