import { describe, it, expect } from 'vitest';
import { borders } from '../../../../../src/cli/tui/theme/borders.js';
import { semantic } from '../../../../../src/cli/tui/theme/palette.js';

describe('theme/borders', () => {
  it('box uses round border style with idle color', () => {
    expect(borders.box.borderStyle).toBe('round');
    expect(borders.box.borderColor).toBe(semantic.borderIdle);
  });

  it('active uses round border style with active color', () => {
    expect(borders.active.borderStyle).toBe('round');
    expect(borders.active.borderColor).toBe(semantic.borderActive);
  });
});
