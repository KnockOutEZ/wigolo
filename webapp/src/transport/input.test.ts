import { describe, it, expect } from 'vitest';
import { toNormalized, domButton, mouseInput, keyInput, modifiersOf, isPrintableKey, keyForwardMessages } from './input.js';

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

  // ── 7f C: human keyboard forwarding must INSERT printable characters (the bug the e2e smoke caught) ──
  // A printable key produces a single Unicode code point in ev.key; a named/control key is a multi-codepoint
  // word. The host inserts text only on a `text`-bearing event, so a printable keyDown must forward a `char`
  // (converging on the agent path's {type:'char', text} shape); a named key must NOT (else 'Enter' inserts the
  // literal word). Detection is by CODE-POINT count, not ev.key.length, so a non-BMP printable is not missed.
  describe('printable-key detection + char forwarding (7f C)', () => {
    it('classifies printables by code-point count — letters/digits/space/symbols/CJK/emoji are printable; named keys are not', () => {
      for (const k of ['a', 'A', '1', ' ', '€', '中', '😀']) expect(isPrintableKey(k), k).toBe(true);
      for (const k of ['Enter', 'Tab', 'Backspace', 'ArrowLeft', 'Escape', 'Shift', 'F1', 'Home', 'Dead']) expect(isPrintableKey(k), k).toBe(false);
    });

    // PIN (i): a printable keyDown forwards a char carrying the character. NAMED mutation that REDs against the
    // present fix: drop the char message for a printable keyDown → the payload loses its {type:'char',text}
    // entry (diverging value: a char message present → absent; the host inserts nothing).
    it('PIN (i): a printable keyDown forwards keyDown + a {type:char,text} event with the character', () => {
      const msgs = keyForwardMessages('keydown', { key: 'a', code: 'KeyA' }, 7);
      const ch = msgs.find((m) => (m as { type?: string }).type === 'char');
      expect(ch, 'a printable keyDown must forward a char event').toBeTruthy();
      expect(ch).toMatchObject({ t: 'input', kind: 'key', type: 'char', text: 'a', epoch: 7 });
      expect(msgs.some((m) => (m as { type?: string }).type === 'keyDown')).toBe(true); // the keyDown still rides
    });

    // PIN (ii): a NAMED/control key forwards NO char (no literal-text insert). NAMED mutation that REDs:
    // extend the char forward to named keys → a {type:char,text:'Enter'} appears (diverging value: 0 char
    // messages → 1, inserting the word "Enter" into the page).
    it('PIN (ii): a named/control key (Enter, ArrowLeft) forwards keyDown only — never a char', () => {
      for (const key of ['Enter', 'ArrowLeft']) {
        const msgs = keyForwardMessages('keydown', { key, code: key === 'Enter' ? 'Enter' : 'ArrowLeft' }, 0);
        expect(msgs.some((m) => (m as { type?: string }).type === 'char'), `${key} must not forward a char`).toBe(false);
        expect(msgs.some((m) => (m as { type?: string }).type === 'keyDown')).toBe(true);
      }
    });

    // PIN (iii): a non-BMP printable (emoji, ev.key.length===2 but ONE code point) forwards its char. NAMED
    // mutation that REDs: use a length-based predicate (ev.key.length===1) → '😀' is misclassified as
    // non-printable and forwards NO char (diverging value: a char present → absent) — the length===1 trap.
    it('PIN (iii): a non-BMP printable (emoji) forwards its char — guards the ev.key.length===1 trap', () => {
      const emoji = '😀'; // U+1F600 — one code point, two UTF-16 units
      expect(emoji.length).toBe(2); // the trap: a length-based predicate would reject this
      const msgs = keyForwardMessages('keydown', { key: emoji }, 1);
      const ch = msgs.find((m) => (m as { type?: string }).type === 'char');
      expect(ch).toMatchObject({ type: 'char', text: emoji });
    });

    it('a keyUp forwards only keyUp (no char on release)', () => {
      const msgs = keyForwardMessages('keyup', { key: 'a', code: 'KeyA' }, 2);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ type: 'keyUp', key: 'a' });
    });
  });
});
