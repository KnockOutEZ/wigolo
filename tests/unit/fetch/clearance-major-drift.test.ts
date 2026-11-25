import { describe, it, expect, afterEach } from 'vitest';
import { uaMatchesTier } from '../../../src/fetch/clearance-reuse.js';
import {
  STEALTH_CHROME_MAJOR,
  resolveStealthUA,
  recordLaunchedChromeMajor,
  currentStealthChromeMajor,
} from '../../../src/fetch/stealth.js';

/**
 * The browser tier no longer advertises a hardcoded Chrome major: it reads the
 * ACTUAL launched browser's `version()` (T1-C) and mints the clearance under
 * THAT UA. If the reuse gate keeps comparing against the static pin, every
 * clearance minted on a machine whose installed Chrome differs from the pin is
 * unreplayable — the whole reuse feature silently no-ops. These tests pin the
 * gate to the major the tier will actually present.
 */
describe('clearance reuse survives a launched-major ≠ pinned-major drift', () => {
  afterEach(() => {
    recordLaunchedChromeMajor(null);
  });

  it('defaults to the shared pin when no browser has launched yet', () => {
    expect(currentStealthChromeMajor()).toBe(STEALTH_CHROME_MAJOR);
  });

  it('accepts a clearance minted under the REAL installed major, not just the pin', () => {
    const realMajor = STEALTH_CHROME_MAJOR + 9;
    const mintedUa = resolveStealthUA('darwin', realMajor);

    // Before the tier reports what it launched, the gate only knows the pin.
    expect(uaMatchesTier(mintedUa, 'browser')).toBe(false);

    // Once the tier records the browser it actually launched, the clearance it
    // minted under that same UA must be replayable.
    recordLaunchedChromeMajor(realMajor);
    expect(currentStealthChromeMajor()).toBe(realMajor);
    expect(uaMatchesTier(mintedUa, 'browser')).toBe(true);
  });

  it('still REFUSES a Chrome UA from a different major than the launched browser', () => {
    recordLaunchedChromeMajor(151);
    const staleUa = resolveStealthUA('darwin', 120);
    expect(uaMatchesTier(staleUa, 'browser')).toBe(false);
  });

  it('still REFUSES a non-Chrome UA whatever the launched major is', () => {
    recordLaunchedChromeMajor(151);
    const firefox =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
    expect(uaMatchesTier(firefox, 'browser')).toBe(false);
  });

  it('reverts to the pin when the launched major is cleared', () => {
    recordLaunchedChromeMajor(151);
    recordLaunchedChromeMajor(null);
    expect(currentStealthChromeMajor()).toBe(STEALTH_CHROME_MAJOR);
    expect(uaMatchesTier(resolveStealthUA('darwin', 151), 'browser')).toBe(false);
  });
});
