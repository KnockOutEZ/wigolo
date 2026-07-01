import { describe, it, expect } from 'vitest';
import { buildEngineWarnings } from '../../../src/search/core/engine-warnings.js';
import type { EngineTelemetry } from '../../../src/types.js';

// Unit tests for engine_warnings construction.
//
// WHY: lobsters 400 and github-code 401 were previously only visible in
// debug-shaped telemetry. The warning surface must promote them into a
// stable top-level array so callers branch on engine health without
// extra flags — including the env-var hint for documented 401 engines.

function tel(name: string, outcome: EngineTelemetry['outcome'], error?: string): EngineTelemetry {
  return {
    name,
    latency_ms: 10,
    result_count: 0,
    outcome,
    dedup_kept: 0,
    ...(error ? { error } : {}),
  };
}

describe('buildEngineWarnings (M2)', () => {
  it('returns an empty array when no engines errored', () => {
    const warnings = buildEngineWarnings([
      tel('bing', 'ok'),
      tel('ddg', 'ok'),
      tel('wikipedia', 'skipped'),
    ]);
    expect(warnings).toEqual([]);
  });

  it('extracts http_400 from "Engine returned 400" error messages', () => {
    const warnings = buildEngineWarnings([
      tel('lobsters', 'error', 'Lobsters returned 400'),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      engine: 'lobsters',
      code: 'http_400',
      message: 'Lobsters returned 400',
    });
    // 400 is not an auth shape, no hint.
    expect(warnings[0].hint).toBeUndefined();
  });

  it('extracts http_401 and attaches the documented env-var hint for github-code', () => {
    const warnings = buildEngineWarnings([
      tel('github-code', 'error', 'GitHub code returned 401'),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      engine: 'github-code',
      code: 'http_401',
      message: 'GitHub code returned 401',
    });
    // Hint must name the env var so users can fix the gap.
    expect(warnings[0].hint).toMatch(/WIGOLO_GITHUB_TOKEN/);
  });

  it('does NOT emit warnings for outcome=skipped (deliberate non-failure path)', () => {
    // Skipped engines (cache-only, vertical mismatch) are not failures — the
    // user explicitly opted out. Promoting them to warnings would be noise.
    const warnings = buildEngineWarnings([
      tel('news-rss', 'skipped'),
    ]);
    expect(warnings).toEqual([]);
  });

  it('classifies non-HTTP failures with generic codes', () => {
    const warnings = buildEngineWarnings([
      tel('engine-a', 'error', 'Request timeout after 5000ms'),
      tel('engine-b', 'error', 'getaddrinfo ENOTFOUND example.com'),
      tel('engine-c', 'error', 'JSON parse failed: unexpected token'),
    ]);
    expect(warnings[0].code).toBe('timeout');
    expect(warnings[1].code).toBe('dns');
    expect(warnings[2].code).toBe('error');
  });

  it('returns empty when telemetry is undefined or empty', () => {
    expect(buildEngineWarnings(undefined)).toEqual([]);
    expect(buildEngineWarnings([])).toEqual([]);
  });

  it('does NOT attach hint when 401 happens on an engine without a documented env var', () => {
    const warnings = buildEngineWarnings([
      tel('unknown-engine', 'error', 'unknown-engine returned 401'),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('http_401');
    // Unknown engines don't get fabricated hints — only the registry does.
    expect(warnings[0].hint).toBeUndefined();
  });
});
