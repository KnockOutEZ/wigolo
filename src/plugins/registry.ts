import { createLogger } from '../logger.js';
import type { Extractor, SearchEngine } from '../types.js';

const log = createLogger('server');

interface RegisteredExtractor {
  extractor: Extractor;
  pluginName: string;
}

interface RegisteredSearchEngine {
  engine: SearchEngine;
  pluginName: string;
}

export interface PluginRegistryState {
  extractors: Array<{ name: string; pluginName: string }>;
  searchEngines: Array<{ name: string; pluginName: string }>;
  pluginCount: number;
}

export class PluginRegistry {
  private extractors: RegisteredExtractor[] = [];
  private engines: RegisteredSearchEngine[] = [];
  private pluginNames = new Set<string>();

  registerExtractor(extractor: Extractor, pluginName: string): void {
    if (this.extractors.some(r => r.extractor.name === extractor.name)) {
      log.warn('duplicate extractor name, ignoring', {
        name: extractor.name,
        plugin: pluginName,
      });
      return;
    }
    this.extractors.push({ extractor, pluginName });
    this.pluginNames.add(pluginName);
    log.debug('registered plugin extractor', {
      name: extractor.name,
      plugin: pluginName,
    });
  }

  registerSearchEngine(engine: SearchEngine, pluginName: string): void {
    if (this.engines.some(r => r.engine.name === engine.name)) {
      log.warn('duplicate search engine name, ignoring', {
        name: engine.name,
        plugin: pluginName,
      });
      return;
    }
    this.engines.push({ engine, pluginName });
    this.pluginNames.add(pluginName);
    log.debug('registered plugin search engine', {
      name: engine.name,
      plugin: pluginName,
    });
  }

  getExtractors(): Extractor[] {
    return this.extractors.map(r => r.extractor);
  }

  getSearchEngines(): SearchEngine[] {
    return this.engines.map(r => r.engine);
  }

  getExtractorByName(name: string): Extractor | undefined {
    return this.extractors.find(r => r.extractor.name === name)?.extractor;
  }

  getSearchEngineByName(name: string): SearchEngine | undefined {
    return this.engines.find(r => r.engine.name === name)?.engine;
  }

  getState(): PluginRegistryState {
    return {
      extractors: this.extractors.map(r => ({
        name: r.extractor.name,
        pluginName: r.pluginName,
      })),
      searchEngines: this.engines.map(r => ({
        name: r.engine.name,
        pluginName: r.pluginName,
      })),
      pluginCount: this.pluginNames.size,
    };
  }

  clear(): void {
    this.extractors = [];
    this.engines = [];
    this.pluginNames.clear();
  }
}
