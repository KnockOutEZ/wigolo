import { describe, it, expect } from 'vitest';
import { classifyRisk } from 'wigolo/studio';
import * as studio from 'wigolo/studio';

// Proves the `wigolo` file:../.. dependency + the `./studio` exports subpath
// resolve the built core from the app workspace (P0 §13.5 locked mechanism).
describe('wigolo/studio subpath resolves the built core', () => {
  it('imports a pure salvaged domain symbol and it works', () => {
    const tier = classifyRisk({ action: 'click', pageUrl: 'https://shop.example.com/checkout' });
    expect(tier).toBe('money');
  });

  it('exposes the P2 mark-domain symbols the app host imports', () => {
    expect(typeof studio.MarkStore).toBe('function');
    expect(typeof studio.buildTarget).toBe('function');
    expect(typeof studio.buildTargetFromFlat).toBe('function');
    expect(typeof studio.indexAxByBackendNode).toBe('function');
    expect(typeof studio.heal).toBe('function');
    expect(typeof studio.generalize).toBe('function');
    expect(typeof studio.applyGeometry).toBe('function');
    expect(typeof studio.resolveNodePath).toBe('function');
    expect(typeof studio.computeFingerprint).toBe('function');
    expect(typeof studio.isCredentialContext).toBe('function');
    expect(typeof studio.neutralizeMarkers).toBe('function');
  });
});
