import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROWSER_DRIVER_MISSING_ERROR,
  BROWSER_DRIVER_VERSION,
  DRIVER_INSTALL_DIRNAME,
  browserDriverInstalled,
  driverInstallRoot,
  loadBrowserDriver,
  loadBrowserDriverSync,
  requireBrowserDriver,
  resetBrowserDriverCache,
  resolveDriverPackageJson,
  _setBrowserDriverForTests,
  type BrowserDriverModule,
} from '../../../src/fetch/browser-driver.js';
import { getConfig } from '../../../src/config.js';

/**
 * S10-e. The seam exists because a top-level value import of an optional package makes that
 * package mandatory: the module graph fails to load, so a missing rung becomes a dead process.
 * These tests drive the seam's two jobs — resolve when it can, refuse legibly when it cannot —
 * and the concurrency property that a value-only memo silently broke.
 */

function fakeEngine(path: string) {
  return { executablePath: () => path, launch: async () => ({ close: async () => undefined }) };
}

function fakeDriver(): BrowserDriverModule {
  return {
    chromium: fakeEngine('/fake/chromium'),
    firefox: fakeEngine('/fake/firefox'),
    webkit: fakeEngine('/fake/webkit'),
  } as unknown as BrowserDriverModule;
}

describe('browser driver seam', () => {
  beforeEach(() => {
    _setBrowserDriverForTests(undefined);
  });
  afterEach(() => {
    _setBrowserDriverForTests(undefined);
  });

  it('resolves the driver when one is installed', async () => {
    const driver = await loadBrowserDriver();
    expect(driver).not.toBeNull();
    expect(typeof driver?.chromium.launch).toBe('function');
  });

  it('memoizes, so an absent package is not re-probed on every fetch', async () => {
    const first = await loadBrowserDriver();
    const second = await loadBrowserDriver();
    expect(second).toBe(first);
  });

  it('single-flights concurrent callers onto one resolution', async () => {
    // ⚠ THE REGRESSION THIS PINS, observed rather than imagined. `doctor` probes chromium,
    // firefox and webkit through `Promise.all`, so three callers arrive before any has finished
    // awaiting. With only a VALUE memo each started its own import, and under a mocked module
    // graph the first got the mock while its siblings got the real package — a difference the
    // caller can see, and one that made five doctor assertions read the wrong browser.
    resetBrowserDriverCache();
    const [a, b, c] = await Promise.all([loadBrowserDriver(), loadBrowserDriver(), loadBrowserDriver()]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('reports absence rather than throwing, when nothing resolves', async () => {
    _setBrowserDriverForTests(null);
    expect(await loadBrowserDriver()).toBeNull();
    expect(loadBrowserDriverSync()).toBeNull();
    expect(browserDriverInstalled()).toBe(false);
  });

  it('refuses with the remedy when a caller cannot proceed without one', async () => {
    _setBrowserDriverForTests(null);
    await expect(requireBrowserDriver()).rejects.toThrow(BROWSER_DRIVER_MISSING_ERROR);
  });

  it('names an actionable command in the refusal, not just a missing thing', () => {
    // D-S10-9: a rung that vanishes without a remedy is indistinguishable from a broken install.
    expect(BROWSER_DRIVER_MISSING_ERROR).toContain('wigolo warmup --browser');
  });

  it('keeps the refusal in capability language', () => {
    // The message reaches users. Same rule the tier strings follow.
    expect(BROWSER_DRIVER_MISSING_ERROR.toLowerCase()).not.toContain('playwright');
    expect(BROWSER_DRIVER_MISSING_ERROR).toContain('browser engine');
  });

  it('hands back the module when one is present', async () => {
    const driver = fakeDriver();
    _setBrowserDriverForTests(driver);
    expect(await requireBrowserDriver()).toBe(driver);
  });

  it('memoizes a NEGATIVE answer, and drops it so a mid-process acquisition becomes visible', async () => {
    /*
     * ⚠ WHY THIS TEST IS BUILT THE HARD WAY. The obvious version forces absence with
     * `_setBrowserDriverForTests(null)` — and that version is worthless: the override answers
     * before the memo is ever consulted, so the memo is never populated and deleting the
     * invalidation entirely leaves it green. Verified, not assumed: as first written this
     * assertion red 0 of 1 under exactly that mutation.
     *
     * So absence is produced by the real resolution failing, via a module-graph mock that
     * throws on its first evaluation and succeeds on its second. The attempt counter is the
     * outside signal — it distinguishes "the second call was served from the memo" from "the
     * second call re-resolved and happened to agree".
     */
    vi.resetModules();
    let attempts = 0;
    vi.doMock('playwright', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('driver not installed');
      return fakeDriver();
    });
    const fresh = await import('../../../src/fetch/browser-driver.js');
    try {
      expect(await fresh.loadBrowserDriver()).toBeNull();
      expect(attempts).toBe(1);

      // Still absent, and WITHOUT a second resolution attempt — that is the memo.
      expect(await fresh.loadBrowserDriver()).toBeNull();
      expect(attempts).toBe(1);

      // The acquisition just falsified the memo, so it is dropped and the rung reappears.
      fresh.resetBrowserDriverCache();
      expect(await fresh.loadBrowserDriver()).not.toBeNull();
      expect(attempts).toBe(2);
    } finally {
      vi.doUnmock('playwright');
      vi.resetModules();
    }
  });

  it('rejects a module that is not actually a driver', async () => {
    // The shape is checked rather than assumed: an unrelated package that happens to resolve
    // under this name would otherwise be handed to `launch()` and fail somewhere far away.
    _setBrowserDriverForTests({ chromium: fakeEngine('/x') } as unknown as BrowserDriverModule);
    const driver = await loadBrowserDriver();
    expect(driver?.firefox).toBeUndefined();
  });

  it('resolves the package.json the acquirer and the runtime must agree on', () => {
    const path = resolveDriverPackageJson();
    expect(path).not.toBeNull();
    const pkg = JSON.parse(readFileSync(path as string, 'utf8')) as { name?: string };
    expect(pkg.name).toBe('playwright');
  });

  it('installs into the data directory, under a named subdirectory', () => {
    // The acquired copy must not land in the user's project or next to wigolo's own tree.
    expect(driverInstallRoot()).toBe(join(getConfig().dataDir, DRIVER_INSTALL_DIRNAME));
  });
});

describe('the driver is off the default install path, and stays off', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    optionalDependencies?: Record<string, string>;
  };

  it('is not a runtime dependency', () => {
    // The whole size lever. `npm i -g wigolo` measured 698 MiB with this entry and 681 without.
    expect(manifest.dependencies?.['playwright']).toBeUndefined();
  });

  it('is not an optionalDependency either, because npm installs those', () => {
    // ⚠ THE DISTINCTION THAT MAKES THIS WORK, and the one that is easy to get wrong: npm
    // installs `optionalDependencies` by default. Moving the driver there would have changed
    // the manifest and not a single installed byte. Only an OPTIONAL PEER is skipped.
    expect(manifest.optionalDependencies?.['playwright']).toBeUndefined();
  });

  it('is an optional peer, so npm skips it', () => {
    expect(manifest.peerDependencies?.['playwright']).toBeDefined();
    expect(manifest.peerDependenciesMeta?.['playwright']?.optional).toBe(true);
  });

  it('stays a devDependency, so this repo\'s own suites still have one', () => {
    // Including the studio e2e specs, which import the driver directly.
    expect(manifest.devDependencies?.['playwright']).toBeDefined();
  });

  it('pins the acquired revision to the declared one', () => {
    // ⚠ A duplicated version is a version that drifts, and this pair drifting is not cosmetic:
    // the driver and its browser binary are versioned together, so a skew surfaces as an
    // executable path pointing at a revision directory that does not exist.
    expect(BROWSER_DRIVER_VERSION).toBe(manifest.peerDependencies?.['playwright']);
    expect(BROWSER_DRIVER_VERSION).toBe(manifest.devDependencies?.['playwright']);
  });
});

describe('no module in src/ holds a value import of the driver', () => {
  /*
   * The sweep is the point of the slice: one surviving value import re-imposes the dependency
   * for everyone, and it would do so silently — the tree that runs CI has the driver installed,
   * so nothing here would fail. Only a user without one would find out.
   */
  it('sweeps src/ for value imports, and can see the file it excuses', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const root = new URL('../../../src/', import.meta.url);

    async function walk(dir: URL): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        // A plain path join, never `new URL(...).pathname` — that yields `/C:/...` on win32 and
        // reds Windows alone.
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) out.push(...(await walk(child)));
        else if (entry.name.endsWith('.ts')) out.push(child.href);
      }
      return out;
    }

    const files = await walk(root);
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    let sawTypeOnlyImport = false;
    for (const href of files) {
      const src = await readFile(new URL(href), 'utf8');
      for (const line of src.split('\n')) {
        // Anchored at the statement, not anywhere in the line: this file's own prose discusses
        // `import { chromium } from 'playwright'` as the thing being removed, and a substring
        // match reds on the explanation of the rule.
        if (!/^\s*(?:import|export)\b.*from '(?:playwright)'/.test(line)) continue;
        if (/^\s*import\s+type\s/.test(line)) {
          sawTypeOnlyImport = true;
          continue;
        }
        offenders.push(`${href}: ${line.trim()}`);
      }
    }

    // CONTROL: the sweep must be able to see the lines it deliberately skips, or "no offenders"
    // would also be the answer when the matcher is simply broken.
    expect(sawTypeOnlyImport).toBe(true);
    expect(offenders).toEqual([]);
  });
});
