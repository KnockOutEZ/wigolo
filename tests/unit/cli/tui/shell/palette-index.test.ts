import { describe, it, expect } from 'vitest';
import { buildPaletteIndex, fuzzyScore } from '../../../../../src/cli/tui/shell/palette-index.js';
import { CATALOG } from '../../../../../src/cli/tui/schema/catalog.js';

describe('palette-index', () => {
  it('contains one entry per field + one per action + one per category', () => {
    const ACTION_LABELS = ['Verify', 'Doctor', 'Export', 'Import', 'Uninstall'];
    const idx = buildPaletteIndex({ catalog: CATALOG, actionLabels: ACTION_LABELS });
    const fieldCount = CATALOG.flatMap(c => c.fields).length;
    expect(idx.filter(e => e.kind === 'field').length).toBe(fieldCount);
    expect(idx.filter(e => e.kind === 'category').length).toBe(CATALOG.length);
    expect(idx.filter(e => e.kind === 'action').length).toBe(ACTION_LABELS.length);
  });

  it('fuzzyScore prefers substring + adjacency matches', () => {
    expect(fuzzyScore('llm key', 'LLM provider › API key')).toBeGreaterThan(0);
    expect(fuzzyScore('llmkey', 'LLM provider › API key')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'LLM provider › API key')).toBe(0);
  });

  it('fuzzyScore multi-word query gets same substring bonus as collapsed form', () => {
    // "llm key" → stripped to "llmkey"; "llmkey" directly.
    // Both should produce the same score since the substring "llmkey" exists
    // in the space-stripped candidate.
    const multiWord = fuzzyScore('llm key', 'LLM provider › API key');
    const collapsed = fuzzyScore('llmkey', 'LLM provider › API key');
    expect(multiWord).toBe(collapsed);
    // And both should outscore a scattered non-substring query.
    expect(multiWord).toBeGreaterThan(fuzzyScore('xyz', 'LLM provider API key'));
  });

  it('fuzzyScore returns 1 for empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(1);
  });

  it('fuzzyScore gives higher score for exact substring than scattered chars', () => {
    const exact = fuzzyScore('api', 'API key');
    const scattered = fuzzyScore('apk', 'API key');
    expect(exact).toBeGreaterThan(0);
    expect(exact).toBeGreaterThanOrEqual(scattered);
  });

  it('field entries carry category label in their label', () => {
    const idx = buildPaletteIndex({ catalog: CATALOG, actionLabels: [] });
    const llmField = idx.find(e => e.kind === 'field' && e.label.includes('LLM'));
    expect(llmField).toBeDefined();
  });

  it('category entries have kind=category', () => {
    const idx = buildPaletteIndex({ catalog: CATALOG, actionLabels: [] });
    const cats = idx.filter(e => e.kind === 'category');
    expect(cats.map(c => c.id)).toContain('llm');
    expect(cats.map(c => c.id)).toContain('browser');
  });

  it('action entries have kind=action and correct ids', () => {
    const idx = buildPaletteIndex({ catalog: CATALOG, actionLabels: ['Verify', 'Doctor'] });
    const acts = idx.filter(e => e.kind === 'action');
    expect(acts.map(a => a.id)).toContain('verify');
    expect(acts.map(a => a.id)).toContain('doctor');
  });
});
