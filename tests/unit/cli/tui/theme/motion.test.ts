import { describe, it, expect } from 'vitest';
import { spinner, fade } from '../../../../../src/cli/tui/theme/motion.js';

describe('theme/motion', () => {
  it('spinner.dots has 10 frames', () => {
    expect(spinner.dots.length).toBe(10);
  });

  it('spinner.pulse has 4 frames', () => {
    expect(spinner.pulse.length).toBe(4);
  });

  it('fade.toast is 3000ms', () => {
    expect(fade.toast).toBe(3000);
  });

  it('fade.save is 150ms', () => {
    expect(fade.save).toBe(150);
  });
});
