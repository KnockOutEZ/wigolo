import { describe, it, expect } from 'vitest';
import { handleSearch } from '../../../src/tools/search.js';

const noEngines: any[] = [];
const stubRouter: any = { fetch: async () => { throw new Error('should not be called'); } };

describe('search format hard rename', () => {
  for (const old of ['full', 'context', 'highlights'] as const) {
    it(`rejects format='${old}' with migration error`, async () => {
      const out = await handleSearch({ query: 'x', format: old as any }, noEngines, stubRouter);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error_reason).toMatch(/format renamed/i);
        expect(out.error_reason).toMatch(/evidence/i);
      }
    });
  }
  it('rejects unknown format with valid-values list', async () => {
    const out = await handleSearch({ query: 'x', format: 'wat' as any }, noEngines, stubRouter);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error_reason).toMatch(/unknown format/i);
    }
  });
});
