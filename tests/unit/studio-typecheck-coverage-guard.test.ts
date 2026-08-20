/**
 * Negative + positive tests for `scripts/check-studio-typecheck-coverage.mjs` (known issue P7).
 *
 * The guard exists because three one-line edits silently restore P7 — a narrowed `include`, a
 * `strict: false`, and a deleted CI step — each of which leaves every other gate green. A guard for
 * that class is worthless unless it demonstrably fires on each of the three, so each way of
 * reopening the gap gets a test that FAILS if the guard stops detecting it, plus a must-not-fire
 * case so the guard cannot pass by simply always failing.
 *
 * Every case runs against a synthetic repo root rather than the real one: the guard's whole job is
 * to notice a broken arrangement, and the real tree is (by construction) never broken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../../scripts/check-studio-typecheck-coverage.mjs', import.meta.url));

const WORKFLOW_WITH_STEP = `name: CI
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

const WORKFLOW_WITHOUT_STEP = `name: CI
jobs:
  studio-unit:
    steps:
      - name: Unit tests (studio)
        run: npm test -w apps/studio
`;

interface Fixture {
  readonly include?: readonly string[];
  readonly strict?: boolean;
  readonly workflow?: string;
  /** Extra files to drop into `apps/studio/src` beyond the baseline one. */
  readonly extraSrc?: readonly string[];
}

let root: string;

function buildFixture(f: Fixture = {}): void {
  const app = join(root, 'apps', 'studio');
  mkdirSync(join(app, 'src', 'main'), { recursive: true });
  mkdirSync(join(app, 'tests', 'unit'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });

  writeFileSync(join(app, 'src', 'main', 'index.ts'), 'export const boot = () => 1;\n');
  writeFileSync(join(app, 'tests', 'unit', 'boot.test.ts'), 'export const spec = 1;\n');
  writeFileSync(join(app, 'vitest.config.ts'), 'export default {};\n');
  for (const name of f.extraSrc ?? []) {
    writeFileSync(join(app, 'src', name), 'export const extra = 1;\n');
  }

  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify(
      { compilerOptions: { strict: f.strict ?? true, noEmit: true }, include: f.include ?? ['src', 'tests', '*.config.ts'] },
      null,
      2
    )
  );
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), f.workflow ?? WORKFLOW_WITH_STEP);
}

function runGuard(): { status: number; output: string } {
  const r = spawnSync(process.execPath, [GUARD, root], { encoding: 'utf8' });
  return { status: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sd9-p7-guard-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('apps/studio type-check coverage guard (P7)', () => {
  it('passes on a correctly wired arrangement — otherwise it cannot distinguish broken from whole', () => {
    buildFixture();
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when `include` is narrowed so app files drop out of the project', () => {
    // The P7 shape exactly: tsc still exits 0, over a project that no longer contains the app.
    buildFixture({ include: ['src'] });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('tests/unit/boot.test.ts');
    expect(output).toContain('vitest.config.ts');
  });

  it('fails when a new src file is not matched by `include`', () => {
    // Guards the direction a growing app breaks in: files are added, the project is not widened.
    buildFixture({ include: ['src/main', 'tests', '*.config.ts'], extraSrc: ['renderer.ts'] });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('src/renderer.ts');
  });

  it('fails when the project lists every file but checks almost nothing (`strict: false`)', () => {
    buildFixture({ strict: false });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('strict: true');
  });

  it('fails when ci.yml stops invoking the app type-check — the literal P7 state', () => {
    buildFixture({ workflow: WORKFLOW_WITHOUT_STEP });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('npm run lint -w apps/studio');
  });
});
