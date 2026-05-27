import { describe, expect, it } from 'vitest';
import {
  COMPONENT_REGISTRY,
  FIREFOX_COMPONENT,
  CURATED_ENV_VARS,
  ENV_GROUP_LABELS,
  buildDefaultToggles,
} from '../../../../../src/cli/tui/actions/types.js';

describe('COMPONENT_REGISTRY', () => {
  it('has at least 4 entries', () => {
    expect(COMPONENT_REGISTRY.length).toBeGreaterThanOrEqual(4);
  });

  it('every entry has id, name, purpose, cost, defaultEnabled', () => {
    for (const c of COMPONENT_REGISTRY) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(typeof c.purpose).toBe('string');
      expect(typeof c.cost).toBe('string');
      expect(typeof c.defaultEnabled).toBe('boolean');
    }
  });

  it('contains searxng, chromium, reranker, embeddings', () => {
    const ids = COMPONENT_REGISTRY.map((c) => c.id);
    expect(ids).toContain('searxng');
    expect(ids).toContain('chromium');
    expect(ids).toContain('reranker');
    expect(ids).toContain('embeddings');
  });

  it('does not contain firefox (separate FIREFOX_COMPONENT)', () => {
    const ids = COMPONENT_REGISTRY.map((c) => c.id);
    expect(ids).not.toContain('firefox');
  });
});

describe('FIREFOX_COMPONENT', () => {
  it('has id="firefox" and defaultEnabled=false', () => {
    expect(FIREFOX_COMPONENT.id).toBe('firefox');
    expect(FIREFOX_COMPONENT.defaultEnabled).toBe(false);
  });
});

describe('buildDefaultToggles', () => {
  it('defaults: all COMPONENT_REGISTRY entries on, firefox off', () => {
    const t = buildDefaultToggles(false);
    for (const c of COMPONENT_REGISTRY) {
      expect(t[c.id]).toBe(c.defaultEnabled);
    }
    expect(t['firefox']).toBe(false);
  });

  it('includeFirefox=true enables firefox toggle', () => {
    const t = buildDefaultToggles(true);
    expect(t['firefox']).toBe(true);
  });

  it('all core components default to true', () => {
    const t = buildDefaultToggles();
    expect(t['searxng']).toBe(true);
    expect(t['chromium']).toBe(true);
    expect(t['reranker']).toBe(true);
    expect(t['embeddings']).toBe(true);
  });
});

describe('CURATED_ENV_VARS', () => {
  it('has at least 7 entries', () => {
    expect(CURATED_ENV_VARS.length).toBeGreaterThanOrEqual(7);
  });

  it('every entry has envKey, settingsKey, group, label, description, defaultValue', () => {
    for (const v of CURATED_ENV_VARS) {
      expect(typeof v.envKey).toBe('string');
      expect(typeof v.settingsKey).toBe('string');
      expect(typeof v.group).toBe('string');
      expect(typeof v.label).toBe('string');
      expect(typeof v.description).toBe('string');
      expect(typeof v.defaultValue).toBe('string');
    }
  });

  it('includes WIGOLO_SEARCH with options [core, searxng, hybrid]', () => {
    const entry = CURATED_ENV_VARS.find((v) => v.envKey === 'WIGOLO_SEARCH');
    expect(entry).toBeDefined();
    expect(entry?.options).toContain('core');
    expect(entry?.options).toContain('searxng');
    expect(entry?.options).toContain('hybrid');
  });

  it('includes WIGOLO_LOG_LEVEL with options', () => {
    const entry = CURATED_ENV_VARS.find((v) => v.envKey === 'WIGOLO_LOG_LEVEL');
    expect(entry).toBeDefined();
    expect(entry?.options?.length).toBeGreaterThan(0);
  });

  it('covers all 5 groups (search, browser, cache, embedding, logging)', () => {
    const groups = new Set(CURATED_ENV_VARS.map((v) => v.group));
    expect(groups.has('search')).toBe(true);
    expect(groups.has('browser')).toBe(true);
    expect(groups.has('cache')).toBe(true);
    expect(groups.has('embedding')).toBe(true);
    expect(groups.has('logging')).toBe(true);
  });

  it('does NOT contain any secret keys (braveApiKey, githubToken, etc.)', () => {
    const keys = CURATED_ENV_VARS.map((v) => v.settingsKey.toLowerCase());
    expect(keys).not.toContain('braveapikey');
    expect(keys).not.toContain('githubtoken');
    expect(keys.some((k) => k.includes('key') || k.includes('token') || k.includes('secret'))).toBe(false);
  });
});

describe('ENV_GROUP_LABELS', () => {
  it('has a label for every group used in CURATED_ENV_VARS', () => {
    for (const v of CURATED_ENV_VARS) {
      expect(typeof ENV_GROUP_LABELS[v.group]).toBe('string');
    }
  });
});
