// Slice S11b: every registered engine MUST carry a quality tier so S11c's
// RRF-weighting work has metadata to consume.
//
// WHY: the audit called out "Add evidence-quality scoring per adapter — some
// engines produce better snippets than others; weight RRF accordingly." We
// ship the metadata first (this test), tag every engine in the verticals,
// and leave the multiplier inert until S11c flips it. A missing tier would
// silently fall back to 'medium' on the consuming side; the test makes the
// gap fail-loud at the registry boundary.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  getGeneralEngines,
  _resetGeneralEnginesForTest,
} from '../../../src/search/core/verticals/general.js';
import {
  getNewsEngines,
  _resetNewsEnginesForTest,
} from '../../../src/search/core/verticals/news.js';
import {
  getCodeEngines,
  _resetCodeEnginesForTest,
} from '../../../src/search/core/verticals/code.js';
import {
  getDocsEngines,
  _resetDocsEnginesForTest,
} from '../../../src/search/core/verticals/docs.js';
import {
  getPapersEngines,
  _resetPapersEnginesForTest,
} from '../../../src/search/core/verticals/papers.js';
import { engineQualityTier, qualityRrfMultiplier } from '../../../src/search/core/engine-quality.js';
import type { EngineEntry, EngineQualityTier } from '../../../src/search/core/engine-base.js';
import { resetConfig } from '../../../src/config.js';

function allRegisteredEntries(): EngineEntry[] {
  return [
    ...getGeneralEngines(),
    ...getNewsEngines(),
    ...getCodeEngines(),
    ...getDocsEngines(),
    ...getPapersEngines(),
  ];
}

describe('engine quality tiers (S11b)', () => {
  beforeEach(() => {
    _resetGeneralEnginesForTest();
    _resetNewsEnginesForTest();
    _resetCodeEnginesForTest();
    _resetDocsEnginesForTest();
    _resetPapersEnginesForTest();
    resetConfig();
  });

  it('every registered engine entry carries a quality tier', () => {
    const entries = allRegisteredEntries();
    expect(entries.length).toBeGreaterThan(0);
    const missing = entries
      .filter((e) => !e.quality)
      .map((e) => e.engine.name);
    expect(missing, `engines without a quality tier: ${missing.join(', ')}`).toEqual([]);
  });

  it('every registered engine entry has a tier value in the allowed set', () => {
    const allowed: EngineQualityTier[] = ['high', 'medium', 'low'];
    for (const entry of allRegisteredEntries()) {
      expect(allowed).toContain(entry.quality);
    }
  });

  it('engineQualityTier returns medium for unknown engine names (safe default)', () => {
    // Plugin engines and future adapters that forget to register a tier must
    // not break the pipeline. They default to 'medium' so RRF still works.
    expect(engineQualityTier('engine-that-does-not-exist')).toBe('medium');
  });

  it('qualityRrfMultiplier returns 1.0 for every tier in S11b (S11c flips this)', () => {
    // CRITICAL: S11b ships the metadata only. Changing the multipliers here
    // would silently change ranking — that work is S11c's lane. This test
    // documents the slice boundary; if it fails because S11c landed, update
    // both this assertion and the doc-comment on qualityRrfMultiplier.
    expect(qualityRrfMultiplier('high')).toBe(1);
    expect(qualityRrfMultiplier('medium')).toBe(1);
    expect(qualityRrfMultiplier('low')).toBe(1);
  });

  it('vertical tier assignment is consistent with the central quality registry', () => {
    // Defence-in-depth: the central registry (engine-quality.ts) and the
    // per-vertical tag in the engine entry must agree. If they diverge,
    // S11c's RRF tuning will read the registry but the orchestrator may
    // route differently — a hard-to-debug skew. Fail loud on mismatch.
    for (const entry of allRegisteredEntries()) {
      const registryTier = engineQualityTier(entry.engine.name);
      expect(
        entry.quality,
        `engine ${entry.engine.name}: vertical tag=${entry.quality}, registry=${registryTier}`,
      ).toBe(registryTier);
    }
  });
});
