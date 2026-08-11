import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIN_NODE_MAJOR, checkNodeFloor } from '../../../src/cli/node-floor.js';

const SOURCE = fileURLToPath(new URL('../../../src/cli/node-floor.ts', import.meta.url));

describe('node-floor', () => {
  // The floor exists to keep installs on a runtime that still receives security
  // fixes. Node 20 "Iron" went EOL upstream on 2026-03-24, so a floor that still
  // admitted it would be decorative.
  it('rejects the EOL Node 20 line and accepts the LTS lines above it', () => {
    expect(MIN_NODE_MAJOR).toBe(22);
    expect(checkNodeFloor('v20.19.0').ok).toBe(false);
    expect(checkNodeFloor('v20.19.0').message).toMatch(/requires Node 22/i);
    expect(checkNodeFloor('v22.14.0').ok).toBe(true);
    expect(checkNodeFloor('v24.0.0').ok).toBe(true);
  });

  it('reports the parsed version alongside a rejection so the user sees what they have', () => {
    expect(checkNodeFloor('v20.19.0').version).toBe('20.19.0');
    expect(checkNodeFloor('bogus').ok).toBe(false);
    expect(checkNodeFloor('bogus').version).toBeUndefined();
  });

  // This module is imported by doctor.ts, which is imported by warmup.ts, whose
  // tests call `vi.mock('node:fs', () => ({ ... }))` with a partial factory. A
  // partial mock throws on the first export the factory did not declare, so ANY
  // import here — `node:fs` above all — breaks suites that have nothing to do
  // with the Node floor. That is exactly how this module came to exist: the
  // floor check originally lived in tui/system-check.ts, which imports `statfs`,
  // and wiring it into doctor took out 10 tests across 3 unrelated files.
  // Assert the property directly; the failure mode is far from the cause.
  it('imports nothing, so it cannot drag a mocked builtin into doctor/warmup', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    const imports = src.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toEqual([]);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
