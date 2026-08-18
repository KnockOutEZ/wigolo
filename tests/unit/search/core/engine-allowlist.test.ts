import { describe, it, expect, beforeEach } from 'vitest';
import {
  inspectSearchEngineAllowlist,
  normalizeEngineAllowlist,
} from '../../../../src/search/core/engine-allowlist.js';
import { _resetGeneralEnginesForTest } from '../../../../src/search/core/verticals/general.js';
import { _resetNewsEnginesForTest } from '../../../../src/search/core/verticals/news.js';
import { _resetCodeEnginesForTest } from '../../../../src/search/core/verticals/code.js';
import { _resetDocsEnginesForTest } from '../../../../src/search/core/verticals/docs.js';
import { _resetPapersEnginesForTest } from '../../../../src/search/core/verticals/papers.js';
import { _resetImageEnginesForTest } from '../../../../src/search/core/verticals/images.js';
import { resetConfig } from '../../../../src/config.js';

describe('inspectSearchEngineAllowlist', () => {
  beforeEach(() => {
    _resetGeneralEnginesForTest();
    _resetNewsEnginesForTest();
    _resetCodeEnginesForTest();
    _resetDocsEnginesForTest();
    _resetPapersEnginesForTest();
    _resetImageEnginesForTest();
    resetConfig();
  });

  it('returns empty diagnostics when the caller omitted search_engines', () => {
    expect(inspectSearchEngineAllowlist(undefined)).toEqual({
      unknownEngines: [],
      allowlistFallback: false,
    });
    expect(inspectSearchEngineAllowlist([])).toEqual({
      unknownEngines: [],
      allowlistFallback: false,
    });
  });

  it('treats a known live adapter as matched', () => {
    expect(inspectSearchEngineAllowlist(['duckduckgo'])).toEqual({
      unknownEngines: [],
      allowlistFallback: false,
    });
  });

  it('marks unknown names and sets fallback when nothing matched', () => {
    expect(inspectSearchEngineAllowlist(['not-a-real-engine'])).toEqual({
      unknownEngines: ['not-a-real-engine'],
      allowlistFallback: true,
    });
  });

  it('keeps fallback false when some names still match', () => {
    expect(inspectSearchEngineAllowlist(['duckduckgo', 'google'])).toEqual({
      unknownEngines: ['google'],
      allowlistFallback: false,
    });
  });

  it('normalizes case and whitespace the same way dispatch does', () => {
    expect(normalizeEngineAllowlist([' DuckDuckGo ', 'DUCKDUCKGO', '  '])).toEqual(['duckduckgo']);
  });
});
