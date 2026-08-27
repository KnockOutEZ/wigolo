import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * WHY this exists: `src/` must never import `electron`. That quarantine is what keeps a
 * future Studio repo split (or an engine swap) a SUBSTITUTION rather than a rewrite — the
 * moment one core module reaches for `electron`, the core stops being host-agnostic and the
 * split becomes a refactor. Nothing enforced it before this guard, so the property held only
 * by habit.
 *
 * These tests hold the GUARD honest, not the tree. A guard that has never been observed to
 * fire is an assertion, not a control, so the suite (a) enumerates every import form that
 * would breach the quarantine and requires each to be caught, and (b) points the guard at
 * `apps/studio` — which legitimately imports electron — and requires it to FIRE there. If the
 * detector ever silently stops detecting, the apps/studio case reds even though `src/` is
 * still clean.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'check-src-no-electron.mjs');

function runGuard(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Every import form that reaches the `electron` module. Each MUST be caught. */
const BREACHES: Array<[name: string, source: string]> = [
  ['named import, single quotes', `import { app } from 'electron';\n`],
  ['named import, double quotes', `import { app } from "electron";\n`],
  ['default import', `import electron from 'electron';\n`],
  ['namespace import', `import * as electron from 'electron';\n`],
  ['type-only import', `import type { BrowserWindow } from 'electron';\n`],
  ['side-effect import (no bindings)', `import 'electron';\n`],
  ['multi-line binding list', `import {\n  app,\n  BrowserWindow,\n} from 'electron';\n`],
  ['dynamic import, awaited', `export async function f() {\n  return await import('electron');\n}\n`],
  ['dynamic import, subpath + double quotes', `export const f = () => import("electron/main");\n`],
  ['require', `const { app } = require('electron');\n`],
  ['require, subpath', `const r = require("electron/renderer");\n`],
  ['named re-export', `export { app } from 'electron';\n`],
  ['star re-export', `export * from 'electron';\n`],
];

/** Specifiers and mentions that merely LOOK like a breach. Each MUST be ignored. */
const NON_BREACHES: Array<[name: string, source: string]> = [
  ['electron-store (different package)', `import Store from 'electron-store';\n`],
  ['electron-log (different package)', `import log from 'electron-log';\n`],
  ['relative ./electron-helper', `import { x } from './electron-helper.js';\n`],
  ['line comment', `// import { app } from 'electron';\nexport const x = 1;\n`],
  ['block comment', `/*\n * import { app } from 'electron';\n */\nexport const x = 1;\n`],
  ['string literal mentioning the import', `export const msg = "import { app } from 'electron'";\n`],
];

function writeFixtures(dir: string, cases: Array<[string, string]>, prefix: string): string[] {
  mkdirSync(dir, { recursive: true });
  return cases.map(([, source], i) => {
    const name = `${prefix}-${i}.ts`;
    writeFileSync(join(dir, name), source);
    return name;
  });
}

describe('electron quarantine guard (scripts/check-src-no-electron.mjs)', () => {
  let tmp: string;
  let breachNames: string[];
  let cleanNames: string[];
  let breachRun: { status: number; out: string };
  let cleanRun: { status: number; out: string };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'electron-quarantine-'));
    breachNames = writeFixtures(join(tmp, 'breach'), BREACHES, 'breach');
    cleanNames = writeFixtures(join(tmp, 'clean'), NON_BREACHES, 'clean');
    breachRun = runGuard([join(tmp, 'breach')]);
    cleanRun = runGuard([join(tmp, 'clean')]);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('catches every form that reaches the electron module', () => {
    BREACHES.forEach(([name], i) => {
      it(`flags: ${name}`, () => {
        expect(breachRun.out).toContain(breachNames[i]);
      });
    });

    it('exits non-zero when any breach is present', () => {
      expect(breachRun.status).toBe(1);
    });
  });

  describe('does not fire on lookalikes', () => {
    NON_BREACHES.forEach(([name], i) => {
      it(`ignores: ${name}`, () => {
        expect(cleanRun.out).not.toContain(cleanNames[i]);
      });
    });

    it('exits zero when nothing reaches the electron module', () => {
      expect(cleanRun.status).toBe(0);
    });
  });

  it('is not defeated by a regex literal containing escaped slashes', () => {
    // A naive comment stripper reads the `//` inside /\/\// as a line comment and can go
    // blind for the rest of the file — a FALSE NEGATIVE, the only direction that matters here.
    const dir = join(tmp, 'regex');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'r.ts'), `export const re = /\\/\\//;\nimport { app } from 'electron';\n`);
    const r = runGuard([dir]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('r.ts');
  });

  it('holds: src/ does not import electron', () => {
    const r = runGuard([join(ROOT, 'src')]);
    expect(r.out).not.toMatch(/^FAIL/m);
    expect(r.status).toBe(0);
  });

  it('is not vacuous: fires on apps/studio, which really does import electron', () => {
    // If the detector ever silently stops detecting, `src/` still passes and every fixture
    // case could be quietly rewritten. This is the outside signal that the guard still works
    // against real production code it was never tuned on.
    const r = runGuard([join(ROOT, 'apps', 'studio', 'src')]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/electron/);
  });

  it('is not vacuous: fires on the synthetic electron-importing fixture', () => {
    // The same outside signal as the apps/studio arm above, but not conditional on the app
    // tree being present in this repo. `tests/fixtures/electron-quarantine/electron-host.mjs`
    // is a real file the detector really scans (see its header for why it is `.mjs`), so this
    // reds the moment the detector stops detecting — on any branch.
    const r = runGuard([join(ROOT, 'tests', 'fixtures', 'electron-quarantine')]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('electron-host.mjs');
  });

  it('scopes itself to src/ by default, so apps/studio stays legal', () => {
    const r = runGuard([]);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('apps/studio');
  });

  it('is gated, not documented: gate:studio chains the guard', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:no-electron']).toContain('scripts/check-src-no-electron.mjs');
    expect(pkg.scripts['gate:studio']).toContain('check:no-electron');
  });

  it('is gated, not documented: the CI gate job runs gate:studio', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('npm run gate:studio');
    expect(ci).toMatch(/pull_request:[\s\S]*branches: \[main, studio-handoff\]/);
  });
});
