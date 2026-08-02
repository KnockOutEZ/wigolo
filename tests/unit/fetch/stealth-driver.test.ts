import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveStealthLauncher,
  loadStealthDriver,
  _setStealthDriverForTests,
  type StealthDriverLauncher,
} from '../../../src/fetch/stealth.js';

// A stand-in for a launcher (both the standard fallback and the hardened
// driver). `launch` returns a shape we never introspect in these tests.
function makeLauncher(id: string): StealthDriverLauncher & { id: string } {
  return {
    id,
    launch: vi.fn().mockResolvedValue({ close: vi.fn() }),
  } as unknown as StealthDriverLauncher & { id: string };
}

describe('resolveStealthLauncher (T2-E driver selection)', () => {
  afterEach(() => {
    // Clear the test override so a real dynamic import is not leaked between
    // suites, and reset the memo.
    _setStealthDriverForTests(undefined);
  });

  it('returns the fallback for non-chromium engines even when the hardened driver is present', async () => {
    const hardened = makeLauncher('patchright');
    _setStealthDriverForTests(hardened);
    const fallback = makeLauncher('firefox-standard');

    for (const type of ['firefox', 'webkit'] as const) {
      const chosen = await resolveStealthLauncher(type, 'auto', fallback);
      expect((chosen as { id: string }).id).toBe('firefox-standard');
    }
  });

  it('mode "playwright" NEVER loads the hardened driver, even on chromium with it present', async () => {
    // If the override were consulted the assertion below would fail — but more
    // importantly, `playwright` mode must short-circuit BEFORE loadStealthDriver
    // is ever awaited. Prove that by making the override a poison value: if it
    // were returned we would see 'patchright'.
    const hardened = makeLauncher('patchright');
    _setStealthDriverForTests(hardened);
    const fallback = makeLauncher('chromium-standard');

    const chosen = await resolveStealthLauncher('chromium', 'playwright', fallback);
    expect((chosen as { id: string }).id).toBe('chromium-standard');
  });

  it('mode "auto" on chromium uses the hardened driver when present', async () => {
    const hardened = makeLauncher('patchright');
    _setStealthDriverForTests(hardened);
    const fallback = makeLauncher('chromium-standard');

    const chosen = await resolveStealthLauncher('chromium', 'auto', fallback);
    expect((chosen as { id: string }).id).toBe('patchright');
  });

  it('mode "patchright" on chromium uses the hardened driver when present', async () => {
    const hardened = makeLauncher('patchright');
    _setStealthDriverForTests(hardened);
    const fallback = makeLauncher('chromium-standard');

    const chosen = await resolveStealthLauncher('chromium', 'patchright', fallback);
    expect((chosen as { id: string }).id).toBe('patchright');
  });

  it('falls back to the standard launcher when the hardened driver is ABSENT (optional dep not installed)', async () => {
    // null override == the optional package is not installed. auto + chromium
    // must silently fall back rather than throw or hang.
    _setStealthDriverForTests(null);
    const fallback = makeLauncher('chromium-standard');

    const chosen = await resolveStealthLauncher('chromium', 'auto', fallback);
    expect((chosen as { id: string }).id).toBe('chromium-standard');
  });

  it('loadStealthDriver resolves to null (never throws) when the package cannot be imported', async () => {
    // No override set — the real dynamic import runs. In the test environment
    // the optional package is NOT installed, so this must resolve to null, not
    // throw. (If a dev has it installed locally this still passes: it would
    // resolve to a launcher, and the assertion tolerates either — the contract
    // under test is "never throws".)
    _setStealthDriverForTests(undefined);
    await expect(loadStealthDriver()).resolves.not.toThrow;
    const result = await loadStealthDriver();
    expect(result === null || typeof result.launch === 'function').toBe(true);
  });
});
