// Slice S11a: formatEngineHealthLines unit tests.
//
// WHY: the engine health summary is the cold-start visibility surface for
// doctor — when a user's BRAVE_API_KEY is missing or github-code is gated
// on a token, this output is the only place they see WHY their image
// search degraded. Test the formatter in isolation so the line shape stays
// stable across release cycles.

import { describe, it, expect } from 'vitest';
import { formatEngineHealthLines } from '../../../src/cli/doctor.js';
import type { EngineHealthEntry } from '../../../src/search/core/engine-health.js';

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
});
