import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BUILTIN_ENGINES_BY_VERTICAL,
  formatEngineCatalogListing,
  searchEnginesSchemaDescription,
} from '../../../../src/search/core/engine-catalog.js';
import {
  getGeneralEngines,
  _resetGeneralEnginesForTest,
} from '../../../../src/search/core/verticals/general.js';
import {
  getNewsEngines,
  _resetNewsEnginesForTest,
} from '../../../../src/search/core/verticals/news.js';
import {
  getCodeEngines,
  _resetCodeEnginesForTest,
} from '../../../../src/search/core/verticals/code.js';
import {
  getDocsEngines,
  _resetDocsEnginesForTest,
} from '../../../../src/search/core/verticals/docs.js';
import {
  getPapersEngines,
  _resetPapersEnginesForTest,
} from '../../../../src/search/core/verticals/papers.js';
import {
  getImageEngines,
  _resetImageEnginesForTest,
} from '../../../../src/search/core/verticals/images.js';
import { _resetBreakersForTest } from '../../../../src/search/core/engine-base.js';
import { resetConfig } from '../../../../src/config.js';
import { SEARCH_TOOL_SCHEMA } from '../../../../src/server/tool-schemas.js';
import type { Vertical } from '../../../../src/search/core/intent-router.js';

const getters: Record<Vertical, () => { engine: { name: string } }[]> = {
  general: getGeneralEngines,
  news: getNewsEngines,
  code: getCodeEngines,
  docs: getDocsEngines,
  papers: getPapersEngines,
  images: getImageEngines,
};

function resetVerticals(): void {
  _resetGeneralEnginesForTest();
  _resetNewsEnginesForTest();
  _resetCodeEnginesForTest();
  _resetDocsEnginesForTest();
  _resetPapersEnginesForTest();
  _resetImageEnginesForTest();
  _resetBreakersForTest();
}

describe('engine catalog', () => {
  const originalBraveKey = process.env.BRAVE_API_KEY;

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    resetConfig();
    resetVerticals();
  });

  afterEach(() => {
    if (originalBraveKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = originalBraveKey;
    resetConfig();
    resetVerticals();
  });

  it('lists every live engine name for each vertical (keyless pool)', () => {
    for (const vertical of Object.keys(getters) as Vertical[]) {
      const catalog = new Set(BUILTIN_ENGINES_BY_VERTICAL[vertical]);
      for (const name of getters[vertical]().map((e) => e.engine.name)) {
        expect(catalog.has(name), `${name} registered in ${vertical} but missing from the catalog`).toBe(
          true,
        );
      }
    }
  });

  it('lists brave / brave-image when those key-gated adapters join the pool', () => {
    process.env.BRAVE_API_KEY = 'test-key';
    resetConfig();
    resetVerticals();

    expect(getGeneralEngines().map((e) => e.engine.name)).toContain('brave');
    expect(BUILTIN_ENGINES_BY_VERTICAL.general).toContain('brave');
    expect(getCodeEngines().map((e) => e.engine.name)).toContain('brave');
    expect(BUILTIN_ENGINES_BY_VERTICAL.code).toContain('brave');
    expect(getImageEngines().map((e) => e.engine.name)).toContain('brave-image');
    expect(BUILTIN_ENGINES_BY_VERTICAL.images).toContain('brave-image');
  });

  it('keeps the schema description short and points at doctor + engine_warnings', () => {
    const listing = formatEngineCatalogListing();
    const description = searchEnginesSchemaDescription();
    expect(description).toMatch(/case-insensitive/);
    expect(description).toMatch(/engine_warnings/);
    expect(description).toMatch(/wigolo doctor/);
    expect(description.length).toBeLessThan(listing.length);
    expect(listing).toContain('general:');
    expect(listing).toContain('duckduckgo');
    expect(listing).toContain('github-code');
    expect(
      (SEARCH_TOOL_SCHEMA.properties.search_engines as { description: string }).description,
    ).toBe(description);
  });
});
