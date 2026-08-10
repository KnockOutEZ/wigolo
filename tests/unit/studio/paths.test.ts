/**
 * `~/.wigolo` is the SHARED data dir. Five modules independently spelled `join(dataDir, 'studio', …)`,
 * which is the shape of the bug where a second product's output lands in the first product's
 * directory — with the segment repeated per call site nothing decides who owns what.
 *
 * These tests exist for ONE reason: to pin that centralising the definition did NOT move anything on
 * disk. Every expectation below is the literal path that was already in use, so an existing profile
 * store, handoff ledger, escalation ledger, snapshot spill and session handle on a real machine keep
 * resolving. A path change here is a data-loss bug, not a refactor.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { studioStateDir } from '../../../src/studio/paths.js';
import { studioHandlePath } from '../../../src/studio/handle.js';

const DATA = '/tmp/wigolo-paths-test';

describe('studioStateDir', () => {
  it('is the shared data dir plus the product segment — unchanged from the five inlined call sites', () => {
    expect(studioStateDir(DATA)).toBe(join(DATA, 'studio'));
  });

  it('appends further segments without re-spelling the product segment', () => {
    expect(studioStateDir(DATA, 'profiles', 'p1.enc')).toBe(join(DATA, 'studio', 'profiles', 'p1.enc'));
    expect(studioStateDir(DATA, 'snapshots')).toBe(join(DATA, 'studio', 'snapshots'));
    expect(studioStateDir(DATA, 'auth-origins.json')).toBe(join(DATA, 'studio', 'auth-origins.json'));
    expect(studioStateDir(DATA, 'escalation-counters.json')).toBe(join(DATA, 'studio', 'escalation-counters.json'));
  });

  it('never escapes the shared data dir', () => {
    // Compare against join(DATA), not the raw literal: on Windows join() normalises the separators,
    // so `\tmp\…\studio`.startsWith('/tmp/…') is false and the assertion would be about path
    // spelling rather than containment.
    expect(studioStateDir(DATA).startsWith(join(DATA))).toBe(true);
    expect(studioStateDir(DATA, 'x')).toContain(join(DATA, 'studio'));
  });

  it('falls back to the configured data dir when none is passed', () => {
    // All five call sites take an optional dataDir and default to config; the helper must keep that
    // contract or a host-injected dataDir would silently diverge from an ambient one.
    const resolved = studioStateDir();
    expect(resolved.endsWith(join('studio'))).toBe(true);
  });
});

describe('the barrel-exported handle path is byte-identical to before', () => {
  it('still resolves to <dataDir>/studio/current.json', () => {
    // studioHandlePath is part of the public `wigolo/studio` surface AND the discovery contract
    // (0600 handle file). Moving it would strand a running session's handle.
    expect(studioHandlePath(DATA)).toBe(join(DATA, 'studio', 'current.json'));
  });
});
