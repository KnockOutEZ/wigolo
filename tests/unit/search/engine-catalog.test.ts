import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BUILTIN_ENGINES_BY_VERTICAL,
  formatEngineCatalogHint,
  formatEngineCatalogListing,
  searchEnginesSchemaDescription,
} from '../../../src/search/core/engine-catalog.js';
import { VERTICALS } from '../../../src/search/core/intent-router.js';
import { getEngineHealthSummary } from '../../../src/search/core/engine-health.js';
import { SEARCH_TOOL_SCHEMA, TOOL_SCHEMAS } from '../../../src/server/tool-schemas.js';
import { resetConfig } from '../../../src/config.js';
import { getGeneralEngines, _resetGeneralEnginesForTest } from '../../../src/search/core/verticals/general.js';
import { getNewsEngines, _resetNewsEnginesForTest } from '../../../src/search/core/verticals/news.js';
import { getCodeEngines, _resetCodeEnginesForTest } from '../../../src/search/core/verticals/code.js';
import { getDocsEngines, _resetDocsEnginesForTest } from '../../../src/search/core/verticals/docs.js';
import { getPapersEngines, _resetPapersEnginesForTest } from '../../../src/search/core/verticals/papers.js';
import { getImageEngines, _resetImageEnginesForTest } from '../../../src/search/core/verticals/images.js';

// Names that appear in the catalog even when the process has no key / no
// RSS feeds. The schema lists them so callers know the string to pass;
// they are not always in the live pool.
const OPT_IN_NAMES = new Set(['brave', 'brave-image', 'rss-feed']);

const liveByVertical = {
  general: () => getGeneralEngines(),
  news: () => getNewsEngines(),
  code: () => getCodeEngines(),
  docs: () => getDocsEngines(),
  papers: () => getPapersEngines(),
  images: () => getImageEngines(),
} as const;

describe('BUILTIN_ENGINES_BY_VERTICAL (vertical registry export)', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.BRAVE_API_KEY;
    delete process.env.WIGOLO_GITHUB_TOKEN;
    resetConfig();
    _resetGeneralEnginesForTest();
    _resetNewsEnginesForTest();
    _resetCodeEnginesForTest();
    _resetDocsEnginesForTest();
    _resetPapersEnginesForTest();
    _resetImageEnginesForTest();
  });

  afterEach(() => {
    process.env = origEnv;
    resetConfig();
    _resetGeneralEnginesForTest();
    _resetNewsEnginesForTest();
    _resetCodeEnginesForTest();
    _resetDocsEnginesForTest();
    _resetPapersEnginesForTest();
    _resetImageEnginesForTest();
  });

  it('covers every Vertical key so a new category cannot ship without names', () => {
    expect(Object.keys(BUILTIN_ENGINES_BY_VERTICAL).sort()).toEqual([...VERTICALS].sort());
  });

  it('lists every live adapter name, and extra catalog names are only known opt-ins', () => {
    for (const [vertical, getLive] of Object.entries(liveByVertical)) {
      const catalog = BUILTIN_ENGINES_BY_VERTICAL[vertical as keyof typeof liveByVertical];
      const live = getLive().map((e) => e.engine.name);
      for (const name of live) {
        expect(catalog, `${vertical} live engine '${name}' missing from catalog`).toContain(name);
      }
      for (const name of catalog) {
        if (live.includes(name)) continue;
        expect(OPT_IN_NAMES.has(name), `${vertical} catalog extra '${name}' is not a known opt-in`).toBe(true);
      }
    }
  });

  it('lists every live doctor engine under its vertical (drift gate)', () => {
    const summary = getEngineHealthSummary();
    expect(summary.length).toBeGreaterThan(0);
    for (const entry of summary) {
      expect(
        BUILTIN_ENGINES_BY_VERTICAL[entry.vertical],
        `${entry.name} in ${entry.vertical} missing from BUILTIN_ENGINES_BY_VERTICAL`,
      ).toContain(entry.name);
    }
  });
});

describe('search_engines schema + warning copy', () => {
  it('keeps the MCP/CLI schema description under the arg budget; names live in the hint', () => {
    const desc = searchEnginesSchemaDescription();
    const listing = formatEngineCatalogListing();
    expect(desc).toBe(
      (SEARCH_TOOL_SCHEMA.properties.search_engines as { description: string }).description,
    );
    expect(desc).toBe(
      (TOOL_SCHEMAS.search.properties.search_engines as { description: string }).description,
    );
    expect(desc).toContain('Override engine selection');
    expect(desc).toMatch(/case-insensitive/);
    expect(desc).toMatch(/engine_warnings/);
    expect(desc).toMatch(/wigolo doctor/);
    expect(desc.length).toBeLessThan(listing.length);
    expect(listing).toContain('duckduckgo');
    expect(listing).toContain('wikipedia');
    expect(listing).toContain('bing_news');
    expect(listing).toContain('github-code');
    expect(listing).toContain('ddg-image');
    for (const vertical of VERTICALS) {
      expect(listing).toContain(`${vertical}:`);
    }
  });

  it('warning hint names available engines and points at doctor', () => {
    const hint = formatEngineCatalogHint();
    expect(hint.startsWith('available: ')).toBe(true);
    expect(hint).toContain('duckduckgo');
    expect(hint).toContain('arxiv');
    expect(hint).toContain('github-code');
    expect(hint).toMatch(/wigolo doctor/);
  });
});
