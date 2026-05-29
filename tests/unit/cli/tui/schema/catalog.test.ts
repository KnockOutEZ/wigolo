import { describe, it, expect } from 'vitest';
import { CATALOG } from '../../../../../src/cli/tui/schema/catalog.js';

describe('CATALOG', () => {
  it('declares unique category ids', () => {
    const ids = CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every field key in every category is unique across the catalog', () => {
    const keys = CATALOG.flatMap((c) => c.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
