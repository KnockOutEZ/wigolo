import { describe, it, expect } from 'vitest';
import {
  qualityRrfMultiplier,
  resolveEngineWeight,
  QUALITY_WEIGHTS,
} from '../../../../src/search/core/engine-quality.js';

// S11c tier-to-weight contract. S11b ships per-engine `quality` tier metadata;
// S11c reads it and weights the RRF contribution accordingly. Documented here
// so the orchestrator can prefer the tier weight over any caller-supplied
// `weight` and any per-vertical default. Mapping:
//   high   → 1.0
//   medium → 0.7
//   low    → 0.5
describe('engine-quality — tier-to-weight contract (S11c)', () => {
  it('maps high tier to 1.0, medium to 0.7, low to 0.5', () => {
    expect(qualityRrfMultiplier('high')).toBeCloseTo(1.0, 5);
    expect(qualityRrfMultiplier('medium')).toBeCloseTo(0.7, 5);
    expect(qualityRrfMultiplier('low')).toBeCloseTo(0.5, 5);
  });

  it('keeps the high>medium>low monotonic ordering so the RRF favours higher-tier engines', () => {
    expect(qualityRrfMultiplier('high')).toBeGreaterThan(qualityRrfMultiplier('medium'));
    expect(qualityRrfMultiplier('medium')).toBeGreaterThan(qualityRrfMultiplier('low'));
  });

  it('exposes QUALITY_WEIGHTS as the source of truth for tier→weight', () => {
    expect(QUALITY_WEIGHTS.high).toBeCloseTo(1.0, 5);
    expect(QUALITY_WEIGHTS.medium).toBeCloseTo(0.7, 5);
    expect(QUALITY_WEIGHTS.low).toBeCloseTo(0.5, 5);
  });
});

describe('engine-quality — resolveEngineWeight precedence', () => {
  it('prefers the registry tier weight when the engine is known', () => {
    // `wikipedia` is in the high-tier registry so a caller-supplied legacy
    // weight (e.g. an old per-vertical override) must NOT override the tier
    // weight. This keeps tier-based weighting consistent across verticals.
    expect(resolveEngineWeight('wikipedia', 0.2)).toBeCloseTo(1.0, 5);
  });

  it('uses the medium-tier default (0.7) for known medium engines', () => {
    expect(resolveEngineWeight('bing')).toBeCloseTo(0.7, 5);
  });

  it('uses the low-tier weight (0.5) for known low engines', () => {
    expect(resolveEngineWeight('devdocs')).toBeCloseTo(0.5, 5);
    expect(resolveEngineWeight('lobsters')).toBeCloseTo(0.5, 5);
  });

  it('falls back to caller-supplied weight when the engine is unknown', () => {
    expect(resolveEngineWeight('engine-that-does-not-exist', 1.2)).toBeCloseTo(1.2, 5);
  });

  it('defaults to 1.0 when neither registry tier nor legacy weight applies', () => {
    expect(resolveEngineWeight('engine-that-does-not-exist')).toBeCloseTo(1.0, 5);
  });
});
