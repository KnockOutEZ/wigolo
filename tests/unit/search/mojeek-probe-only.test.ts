// Mojeek probe-only by default (burst-load resilience, fix d).
//
// WHY: mojeek is a perma-403 on the benchmark network (UA rotation proven
// insufficient across two rounds). In the primary wave it contributes 0
// results and only burns retry latency + trips its breaker, which cascades
// the pool toward bing-only under burst. Down-ranked to probe-only by DEFAULT:
// held out of the primary wave (no per-call tax) but still available to the
// degraded-recovery wave when the pool collapses and needs every signal.
// Config-overridable via WIGOLO_MOJEEK_PROBE_ONLY=false to restore it to the
// primary wave. Generic mechanism — the roster sets the flag, dispatch logic
// never inspects an engine name.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, resetConfig } from '../../../src/config.js';
import {
  getGeneralEngines,
  _resetGeneralEnginesForTest,
} from '../../../src/search/core/verticals/general.js';
import {
  getNewsEngines,
  _resetNewsEnginesForTest,
} from '../../../src/search/core/verticals/news.js';

const ENV_KEY = 'WIGOLO_MOJEEK_PROBE_ONLY';

describe('mojeek probe-only roster default', () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
    resetConfig();
    _resetGeneralEnginesForTest();
    _resetNewsEnginesForTest();
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
    resetConfig();
    _resetGeneralEnginesForTest();
    _resetNewsEnginesForTest();
  });

  it('defaults searchMojeekProbeOnly to true', () => {
    expect(getConfig().searchMojeekProbeOnly).toBe(true);
  });

  it('marks mojeek probeOnly in the general roster by default', () => {
    const mojeek = getGeneralEngines().find((e) => e.engine.name === 'mojeek');
    expect(mojeek).toBeDefined();
    expect(mojeek!.probeOnly).toBe(true);
  });

  it('marks mojeek probeOnly in the news roster by default', () => {
    const mojeek = getNewsEngines().find((e) => e.engine.name === 'mojeek');
    expect(mojeek).toBeDefined();
    expect(mojeek!.probeOnly).toBe(true);
  });

  it('does NOT mark the primary web engines probeOnly (they stay in the primary wave)', () => {
    // NEGATIVE: the reliable engines must never be held back.
    const general = getGeneralEngines();
    const bing = general.find((e) => e.engine.name === 'bing');
    const ddg = general.find((e) => e.engine.name === 'duckduckgo');
    expect(bing?.probeOnly).toBeUndefined();
    expect(ddg?.probeOnly).toBeUndefined();
  });

  it('restores mojeek to the primary wave when WIGOLO_MOJEEK_PROBE_ONLY=false', () => {
    process.env[ENV_KEY] = 'false';
    resetConfig();
    _resetGeneralEnginesForTest();
    const mojeek = getGeneralEngines().find((e) => e.engine.name === 'mojeek');
    expect(mojeek).toBeDefined();
    // Not held back — primary wave dispatches it.
    expect(mojeek!.probeOnly).not.toBe(true);
  });
});
