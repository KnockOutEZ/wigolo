import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { validatePluginExports } from './validate.js';
import type { Extractor, SearchEngine } from '../types.js';

const log = createLogger('server');

export interface LoadedPlugin {
  name: string;
  version: string;
  path: string;
  hasExtractor: boolean;
  hasSearchEngine: boolean;
}

export interface PluginLoadError {
  pluginName: string;
  message: string;
}

export interface PluginLoadResult {
  extractors: Extractor[];
  searchEngines: SearchEngine[];
  loaded: LoadedPlugin[];
  errors: PluginLoadError[];
}

interface PluginPackageJson {
  name?: string;
  version?: string;
  main?: string;
}

function readPluginPackageJson(pluginDir: string): PluginPackageJson | null {
  const pkgPath = join(pluginDir, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }
  try {
    const raw = readFileSync(pkgPath, 'utf-8');
    return JSON.parse(raw) as PluginPackageJson;
  } catch {
    return null;
  }
}

export async function loadPlugins(): Promise<PluginLoadResult> {
  const config = getConfig();
  const pluginsDir = config.pluginsDir;

  const result: PluginLoadResult = {
    extractors: [],
    searchEngines: [],
    loaded: [],
    errors: [],
  };

  if (!existsSync(pluginsDir)) {
    log.debug('plugins directory does not exist, skipping', { path: pluginsDir });
    return result;
  }

  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch (err) {
    log.warn('failed to read plugins directory', {
      path: pluginsDir,
      error: String(err),
    });
    return result;
  }

  const seenExtractorNames = new Set<string>();
  const seenEngineNames = new Set<string>();

  for (const entry of entries) {
    const pluginDir = join(pluginsDir, entry);

    let stat;
    try {
      stat = statSync(pluginDir);
    } catch {
      continue;
    }

    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      continue;
    }

    // If it's a symlink, resolve and check if target is a directory
    if (stat.isSymbolicLink()) {
      try {
        const resolved = resolve(pluginDir);
        const resolvedStat = statSync(resolved);
        if (!resolvedStat.isDirectory()) continue;
      } catch {
        continue;
      }
    }

    const pkgJson = readPluginPackageJson(pluginDir);
    const pluginName = pkgJson?.name ?? entry;

    if (pkgJson === null) {
      // Check if there is a package.json at all
      if (existsSync(join(pluginDir, 'package.json'))) {
        result.errors.push({
          pluginName: entry,
          message: `failed to parse package.json in ${pluginDir}`,
        });
      }
      continue;
    }

    if (!pkgJson.main) {
      result.errors.push({
        pluginName,
        message: `plugin ${pluginName} has no main field in package.json`,
      });
      continue;
    }

    const entryPath = join(pluginDir, pkgJson.main);
    if (!existsSync(entryPath)) {
      result.errors.push({
        pluginName,
        message: `entry point not found: ${entryPath}`,
      });
      continue;
    }

    let mod: Record<string, unknown>;
    try {
      const fileUrl = pathToFileURL(entryPath).href;
      mod = (await import(fileUrl)) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({
        pluginName,
        message: `failed to load plugin ${pluginName}: ${message}`,
      });
      log.warn('plugin import failed', { plugin: pluginName, error: message });
      continue;
    }

    const validation = validatePluginExports(mod);

    if (validation.errors.length > 0) {
      for (const errMsg of validation.errors) {
        result.errors.push({ pluginName, message: errMsg });
      }
      log.warn('plugin validation failed', { plugin: pluginName, errors: validation.errors });
    }

    let registered = false;

    if (validation.hasExtractor) {
      const extractor = mod.extractor as Extractor;
      if (seenExtractorNames.has(extractor.name)) {
        log.warn('duplicate extractor name, skipping', {
          plugin: pluginName,
          extractorName: extractor.name,
        });
      } else {
        seenExtractorNames.add(extractor.name);
        result.extractors.push(extractor);
        registered = true;
        log.info('loaded plugin extractor', {
          plugin: pluginName,
          extractorName: extractor.name,
        });
      }
    }

    if (validation.hasSearchEngine) {
      const engine = mod.searchEngine as SearchEngine;
      if (seenEngineNames.has(engine.name)) {
        log.warn('duplicate search engine name, skipping', {
          plugin: pluginName,
          engineName: engine.name,
        });
      } else {
        seenEngineNames.add(engine.name);
        result.searchEngines.push(engine);
        registered = true;
        log.info('loaded plugin search engine', {
          plugin: pluginName,
          engineName: engine.name,
        });
      }
    }

    if (registered) {
      result.loaded.push({
        name: pluginName,
        version: pkgJson.version ?? '0.0.0',
        path: pluginDir,
        hasExtractor: validation.hasExtractor,
        hasSearchEngine: validation.hasSearchEngine,
      });
    }
  }

  log.info('plugin loading complete', {
    extractors: result.extractors.length,
    searchEngines: result.searchEngines.length,
    errors: result.errors.length,
  });

  return result;
}
