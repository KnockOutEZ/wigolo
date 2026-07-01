// formatEngineHealthLines unit tests.
//
// WHY: the engine health summary is the cold-start visibility surface for
// doctor — when a user's BRAVE_API_KEY is missing or github-code is gated
// on a token, this output is the only place they see WHY their image
// search degraded. Test the formatter in isolation so the line shape stays
// stable across release cycles.

import { describe, it, expect, vi } from 'vitest';
import { formatEngineHealthLines, runEngineProbeSection } from '../../../src/cli/doctor.js';
import type { EngineHealthEntry } from '../../../src/search/core/engine-health.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';
import type { RawSearchResult } from '../../../src/types.js';

describe('formatEngineHealthLines', () => {
  it('renders one line per entry with status + optional hint', () => {
    const entries: EngineHealthEntry[] = [
      { name: 'bing', vertical: 'general', status: 'ok' },
      { name: 'brave', vertical: 'general', status: 'disabled', hint: 'set BRAVE_API_KEY ...' },
      { name: 'github-code', vertical: 'code', status: 'needs-key', hint: 'set WIGOLO_GITHUB_TOKEN ...' },
    ];
    const lines = formatEngineHealthLines(entries);
    expect(lines.length).toBe(3);
    expect(lines.find((l) => l.includes('bing'))).toMatch(/general\s+ok/);
    expect(lines.find((l) => l.includes('brave'))).toMatch(/disabled \(set BRAVE_API_KEY/);
    expect(lines.find((l) => l.includes('github-code'))).toMatch(/needs-key \(set WIGOLO_GITHUB_TOKEN/);
  });

  it('sorts by vertical then engine name so doctor output is deterministic', () => {
    const entries: EngineHealthEntry[] = [
      { name: 'mojeek', vertical: 'general', status: 'ok' },
      { name: 'bing', vertical: 'general', status: 'ok' },
      { name: 'stackoverflow', vertical: 'code', status: 'ok' },
      { name: 'github-code', vertical: 'code', status: 'ok' },
    ];
    const lines = formatEngineHealthLines(entries);
    // code vertical comes before general alphabetically; github-code before
    // stackoverflow within code.
    expect(lines[0]).toMatch(/github-code\s+code/);
    expect(lines[1]).toMatch(/stackoverflow\s+code/);
    expect(lines[2]).toMatch(/bing\s+general/);
    expect(lines[3]).toMatch(/mojeek\s+general/);
  });

  it('emits a placeholder when no entries are configured', () => {
    const lines = formatEngineHealthLines([]);
    expect(lines).toEqual(['  (no engines configured)']);
  });

  it('does not append the parenthetical hint for ok entries', () => {
    const entries: EngineHealthEntry[] = [
      { name: 'ok-engine', vertical: 'general', status: 'ok', hint: 'should not be shown' },
    ];
    const lines = formatEngineHealthLines(entries);
    expect(lines[0]).not.toMatch(/should not be shown/);
    expect(lines[0]).toMatch(/ok$/);
  });

  // Breaker visibility. WHY: an open breaker is the one state where "ok"
  // config status actively lies to the user — the engine is configured fine
  // but will not dispatch.
  it('renders breaker state and truncated lastError when the breaker is not closed', () => {
    const longError = 'x'.repeat(200);
    const entries: EngineHealthEntry[] = [
      { name: 'mojeek', vertical: 'general', status: 'ok', breaker: 'open', lastError: longError },
      { name: 'marginalia', vertical: 'general', status: 'ok', breaker: 'half-open' },
    ];
    const lines = formatEngineHealthLines(entries);
    const mojeek = lines.find((l) => l.includes('mojeek'))!;
    expect(mojeek).toMatch(/breaker open/);
    expect(mojeek).toContain('x'.repeat(10));
    expect(mojeek).not.toContain(longError); // truncated
    expect(lines.find((l) => l.includes('marginalia'))).toMatch(/breaker half-open/);
  });

  // An informational note (e.g. mojeek's IP-reputation limitation) renders
  // even when the engine is "ok" and the breaker is closed, so the doctor
  // output is honest about why an engine may intermittently go dark.
  it('renders an informational note for ok engines that carry one', () => {
    const entries: EngineHealthEntry[] = [
      { name: 'mojeek', vertical: 'general', status: 'ok', note: 'intermittent 403s (IP reputation)' },
    ];
    const lines = formatEngineHealthLines(entries);
    const mojeek = lines.find((l) => l.includes('mojeek'))!;
    expect(mojeek).toMatch(/ok/);
    expect(mojeek).toContain('intermittent 403s (IP reputation)');
  });

  it('does not render breaker info for closed or never-tripped breakers', () => {
    const entries: EngineHealthEntry[] = [
      { name: 'bing', vertical: 'general', status: 'ok', breaker: 'closed' },
      { name: 'ddg', vertical: 'general', status: 'ok' },
    ];
    const lines = formatEngineHealthLines(entries);
    for (const line of lines) {
      expect(line).not.toMatch(/breaker/);
    }
  });
});

describe('runEngineProbeSection (--probe-engines)', () => {
  function makeEntry(name: string, results: RawSearchResult[] | Error): EngineEntry {
    return {
      engine: {
        name,
        search: vi.fn(async () => {
          if (results instanceof Error) throw results;
          return results;
        }),
      },
    };
  }

  const result: RawSearchResult = {
    title: 'T',
    url: 'https://a.com',
    snippet: 'S',
    relevance_score: 1,
    engine: 'e',
  };

  it('does nothing when the flag is off', async () => {
    const entry = makeEntry('bing', [result]);
    const lines: string[] = [];
    await runEngineProbeSection(false, [entry], (l) => lines.push(l));
    expect(lines).toEqual([]);
    expect(entry.engine.search).not.toHaveBeenCalled();
  });

  it('probes each engine once (deduped by name) and prints ok/error lines', async () => {
    const ok = makeEntry('bing', [result, result]);
    const okDupe = makeEntry('bing', [result]);
    const broken = makeEntry('mojeek', new Error('403 forbidden'));
    const lines: string[] = [];
    await runEngineProbeSection(true, [ok, okDupe, broken], (l) => lines.push(l));

    expect(ok.engine.search).toHaveBeenCalledTimes(1);
    expect(okDupe.engine.search).not.toHaveBeenCalled();
    expect(broken.engine.search).toHaveBeenCalledTimes(1);
    // Probe query shape is pinned: bounded results + timeout, no live tuning.
    expect(ok.engine.search).toHaveBeenCalledWith(
      'wigolo health probe',
      { maxResults: 3, timeoutMs: 5000 },
    );

    const bingLine = lines.find((l) => l.includes('bing'))!;
    expect(bingLine).toMatch(/ok \(\d+ms, 2 results\)/);
    const mojeekLine = lines.find((l) => l.includes('mojeek'))!;
    expect(mojeekLine).toMatch(/error \(403 forbidden\)/);
  });

  it('skips disabled entries — they are parked and must not be probed', async () => {
    const parked = makeEntry('parked', [result]);
    parked.disabled = true;
    const lines: string[] = [];
    await runEngineProbeSection(true, [parked], (l) => lines.push(l));
    expect(parked.engine.search).not.toHaveBeenCalled();
  });
});
