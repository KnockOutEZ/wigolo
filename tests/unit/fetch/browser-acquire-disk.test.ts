import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserInstalledOnDisk, browserReadyForWork, requiredBrowserTypes } from '../../../src/fetch/browser-acquire.js';

// Mock Playwright so the probe never depends on a real install. Each engine
// reports a path from `mock.paths`; a test creates that file or leaves it out.
const mock = vi.hoisted(() => ({
  paths: { chromium: '', firefox: '', webkit: '' },
  throwing: new Set<string>(),
}));

vi.mock('playwright', () => {
  function engine(name: 'chromium' | 'firefox' | 'webkit') {
    return {
      executablePath: () => {
        if (mock.throwing.has(name)) throw new Error(`no ${name}`);
        return mock.paths[name];
      },
    };
  }
  return {
    chromium: engine('chromium'),
    firefox: engine('firefox'),
    webkit: engine('webkit'),
  };
});

describe('browserInstalledOnDisk', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-disk-'));
    mock.paths.chromium = join(dir, 'chromium');
    mock.paths.firefox = join(dir, 'firefox');
    mock.paths.webkit = join(dir, 'webkit');
    mock.throwing.clear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks chromium when no types are given', () => {
    expect(browserInstalledOnDisk()).toBe(false);

    writeFileSync(mock.paths.chromium, '');

    expect(browserInstalledOnDisk()).toBe(true);
  });

  it('checks the configured engine instead of chromium', () => {
    // The reported case: chromium is installed, firefox is configured and missing.
    writeFileSync(mock.paths.chromium, '');

    expect(browserInstalledOnDisk(['firefox'])).toBe(false);

    writeFileSync(mock.paths.firefox, '');

    expect(browserInstalledOnDisk(['firefox'])).toBe(true);
  });

  it('requires every configured engine when several are configured', () => {
    writeFileSync(mock.paths.chromium, '');

    expect(browserInstalledOnDisk(['chromium', 'webkit'])).toBe(false);

    writeFileSync(mock.paths.webkit, '');

    expect(browserInstalledOnDisk(['chromium', 'webkit'])).toBe(true);
  });

  it('falls back to chromium on an empty configured list', () => {
    expect(browserInstalledOnDisk([])).toBe(false);

    writeFileSync(mock.paths.chromium, '');

    expect(browserInstalledOnDisk([])).toBe(true);
  });

  it('reports not installed when executablePath throws', () => {
    mock.throwing.add('firefox');

    expect(browserInstalledOnDisk(['firefox'])).toBe(false);
  });
});

describe('browserReadyForWork — every engine a browser fetch needs (#694)', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-work-'));
    mock.paths.chromium = join(dir, 'chromium');
    mock.paths.firefox = join(dir, 'firefox');
    mock.paths.webkit = join(dir, 'webkit');
    mock.throwing.clear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires chromium even when the pool is configured for firefox only', () => {
    // WHY: the browser tier calls the acquisition gate before the pool launches.
    // The gate probes chromium, so a firefox-only install still blocks a fetch.
    // The naive probe over the configured list alone reports true here.
    writeFileSync(mock.paths.firefox, '');

    expect(browserInstalledOnDisk(['firefox'])).toBe(true);
    expect(browserReadyForWork(['firefox'])).toBe(false);
  });

  it('is ready when the configured engine and chromium are both on disk', () => {
    writeFileSync(mock.paths.firefox, '');
    writeFileSync(mock.paths.chromium, '');

    expect(browserReadyForWork(['firefox'])).toBe(true);
  });

  it('keeps one entry per engine in a stable order', () => {
    expect(requiredBrowserTypes(['firefox', 'firefox'])).toEqual(['chromium', 'firefox']);
    expect(requiredBrowserTypes(['chromium'])).toEqual(['chromium']);
    expect(requiredBrowserTypes([])).toEqual(['chromium']);
  });
});