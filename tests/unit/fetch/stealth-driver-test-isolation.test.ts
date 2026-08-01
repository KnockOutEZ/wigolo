import { describe, it, expect, vi } from 'vitest';
import { getConfig } from '../../../src/config.js';
import { loadStealthDriver, resolveStealthLauncher } from '../../../src/fetch/stealth.js';

/**
 * `patchright` ships as an INSTALLED optionalDependency, and `stealthDriver`
 * defaults to 'auto' — so `resolveStealthLauncher` prefers it over the standard
 * launcher. That silently escapes every `vi.mock('playwright')` in the suite:
 * the pool launches a REAL browser, navigates to a fake host, and the test fails
 * on ERR_NAME_NOT_RESOLVED instead of exercising its mock. It cost 22 test
 * failures that read as environmental flake.
 *
 * tests/setup.ts therefore pins WIGOLO_STEALTH_DRIVER=playwright suite-wide.
 * These tests hold that guarantee so it cannot be quietly dropped.
 */
describe('the suite is pinned to the standard browser driver', () => {
  it('resolves stealthDriver to playwright by default', () => {
    expect(getConfig().stealthDriver).toBe('playwright');
  });

  it('returns the injected launcher, so vi.mock("playwright") is honored', async () => {
    const fallback = { launch: vi.fn() };
    const resolved = await resolveStealthLauncher('chromium', getConfig().stealthDriver, fallback as never);
    expect(resolved).toBe(fallback);
  });

  it('ignores an installed hardened driver entirely in that mode', async () => {
    // Plant a hardened driver as if the optional package were present. In
    // `playwright` mode it must be short-circuited BEFORE resolution, so the
    // fallback still wins. This fails if the mode check is ever reordered after
    // the driver probe.
    const { _setStealthDriverForTests } = await import('../../../src/fetch/stealth.js');
    const hardened = { launch: vi.fn() };
    _setStealthDriverForTests(hardened as never);
    try {
      const fallback = { launch: vi.fn() };
      const resolved = await resolveStealthLauncher('chromium', 'playwright', fallback as never);
      expect(resolved).toBe(fallback);
      expect(resolved).not.toBe(hardened);
      // Sanity: the planted driver IS resolvable — so the assertion above is
      // about the mode gate, not about an absent package.
      await expect(loadStealthDriver()).resolves.toBe(hardened);
    } finally {
      _setStealthDriverForTests(undefined);
    }
  });

  it('a test that wants the hardened driver must opt in explicitly', async () => {
    // Opting in is an injected mock, never the ambient default. The reset lives
    // in `finally`: if the assertion throws, an override left in place would
    // leak into every later test and defeat the pin this whole file exists to
    // hold. (No env save/restore here — this test never writes the var, and
    // restoring an `undefined` would store the STRING "undefined".)
    const { _setStealthDriverForTests } = await import('../../../src/fetch/stealth.js');
    const hardened = { launch: vi.fn() };
    _setStealthDriverForTests(hardened as never);
    try {
      const resolved = await resolveStealthLauncher('chromium', 'auto', { launch: vi.fn() } as never);
      expect(resolved).toBe(hardened);
    } finally {
      _setStealthDriverForTests(undefined);
    }
  });
});
