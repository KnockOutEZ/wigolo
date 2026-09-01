import { createLogger } from '../../../logger.js';

const log = createLogger('cli');

export interface PersistedConfigV1 {
  version: 1;
  settings: Record<string, unknown>;
  provider?: { name?: string; keyLocation?: string };
}

export interface PersistedConfigV2 {
  version: 2;
  settings: Record<string, unknown>;
}

const PASSTHROUGH_KEYS = new Set<string>([
  'browserTypes',
  'dataDir',
  'cacheTtlSearch',
]);

const RENAMED_KEYS: Record<string, string> = {
  WIGOLO_SEARCH: 'searchBackend',
  WIGOLO_ACCOUNTS_URL: 'accountsUrl',
};

const KNOWN_OUTPUT_KEYS = new Set<string>([
  ...PASSTHROUGH_KEYS,
  ...Object.values(RENAMED_KEYS),
  'llmProvider',
  'llmKeyLocation',
]);

export function migrateV1ToV2(input: PersistedConfigV1 | PersistedConfigV2): PersistedConfigV2 {
  if (input.version === 2) {
    return input;
  }

  const v1 = input;
  const out: Record<string, unknown> = {};
  const legacy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(v1.settings ?? {})) {
    if (PASSTHROUGH_KEYS.has(key)) {
      out[key] = value;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(RENAMED_KEYS, key)) {
      const renamed = RENAMED_KEYS[key]!;
      out[renamed] = value;
      continue;
    }
    if (KNOWN_OUTPUT_KEYS.has(key)) {
      out[key] = value;
      continue;
    }
    legacy[key] = value;
    log.warn('migrate: unknown legacy setting preserved under __legacy', {
      key,
    });
  }

  if (v1.provider) {
    if (v1.provider.name !== undefined) {
      out['llmProvider'] = v1.provider.name;
    }
    if (v1.provider.keyLocation !== undefined) {
      out['llmKeyLocation'] = v1.provider.keyLocation;
    }
  }

  if (Object.keys(legacy).length > 0) {
    out['__legacy'] = legacy;
  }

  return {
    version: 2,
    settings: out,
  };
}
