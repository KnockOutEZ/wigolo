import { describe, it, expect } from 'vitest';
import {
  computeLayoutSignature,
  serializeLayoutSignature,
  deserializeLayoutSignature,
  layoutDistance,
  MAX_SIGNATURE_BYTES,
  type LayoutBox,
} from '../../../../src/studio/layout/signature.js';

const VP = { width: 1200, height: 900, devicePixelRatio: 1 };

/** A deliberately dense page — 5000 laid-out boxes, well past the ~900-interactive-element page the perception layer was measured against. */
function densePage(): LayoutBox[] {
  const boxes: LayoutBox[] = [];
  for (let i = 0; i < 5000; i++) {
    boxes.push({ x: (i * 37) % 1180, y: (i * 53) % 8000, width: 120 + (i % 40), height: 24 + (i % 12), textLength: (i * 7) % 300 });
  }
  return boxes;
}

describe('LayoutSignature serialisation — the on-disk form S11d would persist', () => {
  it('round-trips through the wire form with every field intact, and the restored signature is distance 0 from the original', () => {
    const sig = computeLayoutSignature({ boxes: densePage(), viewport: VP });
    const restored = deserializeLayoutSignature(serializeLayoutSignature(sig));
    expect(restored).not.toBeNull();
    expect(restored!.gridX).toBe(sig.gridX);
    expect(restored!.gridY).toBe(sig.gridY);
    expect(restored!.boxCount).toBe(sig.boxCount);
    expect(restored!.clamped).toBe(sig.clamped);
    expect(restored!.trusted).toBe(false);
    expect(Array.from(restored!.cells)).toEqual(Array.from(sig.cells));
    expect(layoutDistance(restored!, sig)).toBe(0);
  });

  it('G-S11a-3: a dense page serialises under 2 KB, which is what makes per-page persistence affordable at 10k cached pages', () => {
    const wire = serializeLayoutSignature(computeLayoutSignature({ boxes: densePage(), viewport: VP }));
    expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(MAX_SIGNATURE_BYTES);
    expect(MAX_SIGNATURE_BYTES).toBeLessThanOrEqual(2048);
  });

  it('a malformed or hostile wire value returns null and never throws — a stored signature is untrusted input on the way back in', () => {
    const wire = serializeLayoutSignature(computeLayoutSignature({ boxes: densePage(), viewport: VP }));
    const bad = [
      '',
      'not-a-signature',
      'lsig1:12x16',
      'lsig1:0x0:1:0:AAAA',
      'lsig1:12x16:1:0:!!!!not-base64!!!!',
      wire.slice(0, wire.length - 40), // truncated payload → wrong cell count
      'lsig9:12x16:1:0:AAAA', // unknown version
    ];
    for (const w of bad) {
      expect(() => deserializeLayoutSignature(w)).not.toThrow();
      expect(deserializeLayoutSignature(w)).toBeNull();
    }
  });
});
