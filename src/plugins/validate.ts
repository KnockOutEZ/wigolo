import { createLogger } from '../logger.js';

const log = createLogger('server');

export function validateExtractor(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== 'object') {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return false;
  }

  if (typeof obj.canHandle !== 'function') {
    return false;
  }

  if (typeof obj.extract !== 'function') {
    return false;
  }

  return true;
}

export function validateSearchEngine(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== 'object') {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return false;
  }

  if (typeof obj.search !== 'function') {
    return false;
  }

  return true;
}

export interface PluginValidationResult {
  hasExtractor: boolean;
  hasSearchEngine: boolean;
  errors: string[];
}

export function validatePluginExports(mod: unknown): PluginValidationResult {
  const result: PluginValidationResult = {
    hasExtractor: false,
    hasSearchEngine: false,
    errors: [],
  };

  if (mod === null || mod === undefined || typeof mod !== 'object') {
    result.errors.push('plugin module is null or not an object');
    return result;
  }

  const exports = mod as Record<string, unknown>;

  if ('extractor' in exports) {
    if (validateExtractor(exports.extractor)) {
      result.hasExtractor = true;
      log.debug('valid extractor export found', {
        name: (exports.extractor as { name: string }).name,
      });
    } else {
      result.errors.push(
        'extractor export exists but does not match the Extractor interface (requires: name: string, canHandle: function, extract: function)',
      );
    }
  }

  if ('searchEngine' in exports) {
    if (validateSearchEngine(exports.searchEngine)) {
      result.hasSearchEngine = true;
      log.debug('valid searchEngine export found', {
        name: (exports.searchEngine as { name: string }).name,
      });
    } else {
      result.errors.push(
        'searchEngine export exists but does not match the SearchEngine interface (requires: name: string, search: function)',
      );
    }
  }

  if (!result.hasExtractor && !result.hasSearchEngine && result.errors.length === 0) {
    result.errors.push(
      'plugin exports neither a valid extractor nor a valid searchEngine',
    );
  }

  return result;
}
