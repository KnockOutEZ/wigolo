import { describe, it, expect } from 'vitest';
import { toNormalized, domButton, mouseInput, keyInput, modifiersOf } from './input.js';

const RECT = { left: 0, top: 0, width: 800, height: 600 };

describe('Studio input forwarding (S5)', () => {
  // PIN-S5 (coord mapping): canvas-relative coords map to the correct normalized viewport coords. NAMED
  // mutation that REDs: divide the y term by rect.width instead of rect.height (or swap nx/ny, or drop the
  // rect.left/top offset) → the center no longer maps to {0.5,0.5} and this assertion fails.
  it('PIN-S5: maps canvas coordinates to normalized [0,1] viewport coords', () => {
    expect(toNormalized(400, 300, RECT)).toEqual({ nx: 0.5, ny: 0.5 });
    expect(toNormalized(0, 0, RECT)).toEqual({ nx: 0, ny: 0 });
    expect(toNormalized(800, 600, RECT)).toEqual({ nx: 1, ny: 1 });
    // distinct nx/ny prove the axes aren't crossed and width≠height matters
    expect(toNormalized(200, 300, RECT)).toEqual({ nx: 0.25, ny: 0.5 });
  });

  it('subtracts the canvas rect offset and clamps out-of-bounds to [0,1]', () => {
    const offset = { left: 100, top: 50, width: 800, height: 600 };
    expect(toNormalized(100, 50, offset)).toEqual({ nx: 0, ny: 0 });
    expect(toNormalized(900, 650, offset)).toEqual({ nx: 1, ny: 1 });
    expect(toNormalized(2000, -100, offset)).toEqual({ nx: 1, ny: 0 }); // clamped
  });

  it('maps DOM button numbers to CDP button names', () => {
    expect(domButton(0)).toBe('left');
    expect(domButton(1)).toBe('middle');
    expect(domButton(2)).toBe('right');
    expect(domButton(9)).toBe('none');
  });

  it('builds {t:"input"} mouse/key messages with kind + host fields, never a party', () => {
    const m = mouseInput({ type: 'mousePressed', nx: 0.5, ny: 0.5, epoch: 4, button: 'left', buttons: 1 });
    expect(m).toEqual({ t: 'input', kind: 'mouse', type: 'mousePressed', nx: 0.5, ny: 0.5, epoch: 4, button: 'left', buttons: 1 });
    expect(m).not.toHaveProperty('party');
    const k = keyInput({ type: 'keyDown', key: 'a', code: 'KeyA', epoch: 4 });
    expect(k).toEqual({ t: 'input', kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', epoch: 4 });
  });

  it('encodes CDP modifier bitmask (Alt=1,Ctrl=2,Meta=4,Shift=8)', () => {
    expect(modifiersOf({})).toBe(0);
    expect(modifiersOf({ shiftKey: true })).toBe(8);
    expect(modifiersOf({ ctrlKey: true, metaKey: true })).toBe(6);
  });
});
