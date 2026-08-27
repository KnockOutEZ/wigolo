/*
 * A synthetic electron-importing module. It is a FIXTURE, never imported by anything.
 *
 * WHY it exists: `tests/unit/electron-quarantine.test.ts` needs an outside signal that the
 * quarantine detector still detects. Pointing it only at `src/` proves nothing — `src/` is
 * clean by construction, so a detector that silently stopped detecting would still be green.
 * The anti-vacuity arm therefore points the detector at real code that DOES import electron
 * and requires it to fire. That role used to be played by `apps/studio/src`, which does not
 * exist on every branch of this repo; this fixture plays it unconditionally.
 *
 * WHY `.mjs` and not `.ts`: the detector scans text and accepts `.mjs`, but the type-checkers
 * must never see this file. `tsconfig.tests-debt.json` includes `tests` glob-wide, and
 * `electron` is not a dependency of the root package — a compiled `.ts` fixture importing it
 * is a TS2307 that raises the debt count and trips the ratchet. `allowJs` is off in the base
 * tsconfig, so no `.mjs` under `tests/` enters any compiled set.
 *
 * Two forms, both of which the detector must catch on their own.
 */
import { app } from 'electron';
const { BrowserWindow } = require('electron');

export function createHostWindow() {
  return app.whenReady().then(() => new BrowserWindow({ show: false }));
}
