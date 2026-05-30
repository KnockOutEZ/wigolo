import { describe, it, expect } from 'vitest';
import { palette, semantic } from '../../../../../src/cli/tui/theme/palette.js';

describe('theme/palette', () => {
  it('exposes raw bubblegum colors', () => {
    expect(palette.pink).toBe('#FF6AC1');
    expect(palette.purple).toBe('#A78BFA');
    expect(palette.bg).toBeUndefined();
  });

  it('exposes semantic aliases that resolve to raw colors', () => {
    expect(semantic.accent).toBe(palette.pink);
    expect(semantic.accentAlt).toBe(palette.purple);
    expect(semantic.borderActive).toBe(palette.pink);
    expect(semantic.borderIdle).toBe(palette.dim);
  });

  it('covers every state needed by status dot', () => {
    expect(semantic.ok).toBe(palette.green);
    expect(semantic.warn).toBe(palette.yellow);
    expect(semantic.err).toBe(palette.red);
  });
});
