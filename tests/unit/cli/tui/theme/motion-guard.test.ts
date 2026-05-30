import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reducedMotion } from '../../../../../src/cli/tui/theme/motion-guard.js';

describe('theme/motion-guard', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalIsTTY = process.stdout.isTTY;
    delete process.env.WIGOLO_TUI_REDUCED_MOTION;
    delete process.env.CI;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true, configurable: true });
  });

  it('returns true when WIGOLO_TUI_REDUCED_MOTION=1', () => {
    process.env.WIGOLO_TUI_REDUCED_MOTION = '1';
    expect(reducedMotion()).toBe(true);
  });

  it('returns true when CI=true', () => {
    process.env.CI = 'true';
    expect(reducedMotion()).toBe(true);
  });

  it('returns true when CI=1', () => {
    process.env.CI = '1';
    expect(reducedMotion()).toBe(true);
  });

  it('returns true when process.stdout.isTTY is false', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true, configurable: true });
    expect(reducedMotion()).toBe(true);
  });

  it('returns false by default (TTY, no env flags)', () => {
    expect(reducedMotion()).toBe(false);
  });

  it('evaluates env at call time, not at module load', () => {
    expect(reducedMotion()).toBe(false);
    process.env.CI = 'true';
    expect(reducedMotion()).toBe(true);
    delete process.env.CI;
    expect(reducedMotion()).toBe(false);
  });
});
