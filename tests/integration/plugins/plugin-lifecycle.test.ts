import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';
import { loadPlugins } from '../../../src/plugins/loader.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { runPluginList, runPluginRemove } from '../../../src/cli/plugin.js';
import type { Extractor, SearchEngine } from '../../../src/types.js';

describe('plugin lifecycle integration', () => {
  const originalEnv = process.env;
  let pluginsDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    pluginsDir = mkdtempSync(join(tmpdir(), 'wigolo-plugin-integ-'));
    process.env.WIGOLO_PLUGINS_DIR = pluginsDir;
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  function createPlugin(name: string, opts: {
    hasExtractor?: boolean;
    hasSearchEngine?: boolean;
    extractorName?: string;
    engineName?: string;
    throws?: boolean;
    invalidShape?: boolean;
    noMain?: boolean;
  } = {}): void {
    const dir = join(pluginsDir, name);
    mkdirSync(dir, { recursive: true });

    const pkg: Record<string, unknown> = {
      name,
      version: '1.0.0',
    };
    if (!opts.noMain) {
      pkg.main = 'index.mjs';
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));

    if (opts.noMain) return;

    const lines: string[] = [];

    if (opts.throws) {
      lines.push('throw new Error("plugin init failed");');
    } else if (opts.invalidShape) {
      lines.push('export const extractor = { name: "bad", noMethods: true };');
    } else {
      if (opts.hasExtractor !== false) {
        const eName = opts.extractorName ?? `${name}-extractor`;
        lines.push(`export const extractor = {
  name: '${eName}',
  canHandle(url) { return url.includes('${name}'); },
  extract(html, url) {
    return {
      title: '${eName} title',
      markdown: html.substring(0, 100),
      metadata: {},
      links: [],
      images: [],
      extractor: 'site-specific',
    };
  },
};`);
      }
      if (opts.hasSearchEngine) {
        const sName = opts.engineName ?? `${name}-engine`;
        lines.push(`export const searchEngine = {
  name: '${sName}',
  async search(query, options) {
    return [{
      title: 'Result for ' + query,
      url: 'https://${name}.example/result',
      snippet: 'Search result',
      relevance_score: 0.9,
      engine: '${sName}',
    }];
  },
};`);
      }
    }

    writeFileSync(join(dir, 'index.mjs'), lines.join('\n'));
  }

  it('loads a valid extractor and it is callable', async () => {
    createPlugin('test-site', { hasExtractor: true, hasSearchEngine: false });

    const result = await loadPlugins();
    expect(result.extractors).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const ext = result.extractors[0] as Extractor;
    expect(ext.canHandle('https://test-site.example/page')).toBe(true);
    expect(ext.canHandle('https://other.example/page')).toBe(false);

    const extracted = ext.extract('<html><body>Hello world from plugin</body></html>', 'https://test-site.example/page');
    expect(extracted).not.toBeNull();
    expect(extracted!.markdown).toContain('Hello world');
  });

  it('loads a valid search engine and it is callable', async () => {
    createPlugin('test-search', {
      hasExtractor: false,
      hasSearchEngine: true,
      engineName: 'test-search-eng',
    });

    // Write entry without extractor
    writeFileSync(join(pluginsDir, 'test-search', 'index.mjs'), `
export const searchEngine = {
  name: 'test-search-eng',
  async search(query) {
    return [{ title: 'Result: ' + query, url: 'https://example.com', snippet: 'test', relevance_score: 0.8, engine: 'test-search-eng' }];
  },
};
`);

    const result = await loadPlugins();
    expect(result.searchEngines).toHaveLength(1);

    const eng = result.searchEngines[0] as SearchEngine;
    const results = await eng.search('test query');
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('test query');
  });

  it('registers plugins into the PluginRegistry', async () => {
    createPlugin('alpha', { hasExtractor: true, hasSearchEngine: true, engineName: 'alpha-eng' });
    createPlugin('beta', { hasExtractor: true, hasSearchEngine: false, extractorName: 'beta-ext' });

    const result = await loadPlugins();
    const registry = new PluginRegistry();

    for (const ext of result.extractors) {
      registry.registerExtractor(ext, ext.name);
    }
    for (const eng of result.searchEngines) {
      registry.registerSearchEngine(eng, eng.name);
    }

    expect(registry.getExtractors()).toHaveLength(2);
    expect(registry.getSearchEngines()).toHaveLength(1);

    const state = registry.getState();
    expect(state.pluginCount).toBe(3); // alpha-extractor, beta-ext, alpha-eng
  });

  it('gracefully handles a mix of valid and invalid plugins', async () => {
    createPlugin('good-plugin', { hasExtractor: true });
    createPlugin('bad-plugin', { invalidShape: true });
    createPlugin('crash-plugin', { throws: true });

    const result = await loadPlugins();
    expect(result.extractors).toHaveLength(1);
    expect(result.extractors[0].name).toBe('good-plugin-extractor');
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('remove deletes the plugin directory', async () => {
    createPlugin('removable', { hasExtractor: true });
    expect(existsSync(join(pluginsDir, 'removable'))).toBe(true);

    runPluginRemove('removable');

    expect(existsSync(join(pluginsDir, 'removable'))).toBe(false);
  });

  it('list shows installed plugins', () => {
    createPlugin('listed-plugin', { hasExtractor: true });

    let output = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    runPluginList();
    spy.mockRestore();

    expect(output).toContain('listed-plugin');
  });

  it('handles concurrent load calls without duplication', async () => {
    createPlugin('concurrent', { hasExtractor: true });

    const [r1, r2] = await Promise.all([loadPlugins(), loadPlugins()]);

    // Both should return the same extractors
    expect(r1.extractors.map(e => e.name)).toEqual(r2.extractors.map(e => e.name));
  });

  it('handles plugin directory with deeply nested structure', async () => {
    const dir = join(pluginsDir, 'deep-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'deep-plugin',
      version: '1.0.0',
      main: 'src/lib/index.mjs',
    }));
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'src', 'lib', 'index.mjs'), `
export const extractor = {
  name: 'deep-ext',
  canHandle(url) { return url.includes('deep'); },
  extract(html, url) {
    return { title: 'Deep', markdown: 'deep content', metadata: {}, links: [], images: [], extractor: 'site-specific' };
  },
};
`);

    const result = await loadPlugins();
    expect(result.extractors.map(e => e.name)).toContain('deep-ext');
  });

  it('handles plugin with empty name in package.json', async () => {
    const dir = join(pluginsDir, 'empty-name');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '',
      version: '1.0.0',
      main: 'index.mjs',
    }));
    writeFileSync(join(dir, 'index.mjs'), `
export const extractor = {
  name: 'empty-name-ext',
  canHandle() { return false; },
  extract() { return null; },
};
`);

    const result = await loadPlugins();
    expect(result.extractors.map(e => e.name)).toContain('empty-name-ext');
  });

  it('handles plugin with long name and version strings', async () => {
    const longName = 'a'.repeat(200);
    createPlugin(longName.substring(0, 100), {
      hasExtractor: true,
      extractorName: 'long-name-ext',
    });

    const result = await loadPlugins();
    expect(result.extractors.map(e => e.name)).toContain('long-name-ext');
  });
});
