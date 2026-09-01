import { createLogger } from '../../../logger.js';
import { parseTelemetryEnv } from '../../../telemetry/off-switch.js';

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

/**
 * Value coercions applied AFTER a rename, keyed by the v2 key.
 *
 * A rename alone copies the value verbatim, which is wrong for a key whose v1 spelling was a
 * string and whose v2 type is boolean: a hand-written `WIGOLO_TELEMETRY: "0"` would arrive as
 * the string `'0'`, `resolveTelemetryEnabled` would ignore it as a non-boolean, and the
 * install would fall through to the 0.3.0 default — ON — silently reversing the one thing the
 * user had written down. Coercing through the same off-value parser the env switch uses keeps
 * an explicit off an explicit off across the version break.
 */
const VALUE_COERCIONS: Record<string, (value: unknown) => unknown> = {
  telemetryEnabled: (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return value;
    return parseTelemetryEnv(value) ?? value;
  },
};

const RENAMED_KEYS: Record<string, string> = {
  WIGOLO_SEARCH: 'searchBackend',
  WIGOLO_ACCOUNTS_URL: 'accountsUrl',
  WIGOLO_TELEMETRY: 'telemetryEnabled',
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
      const coerce = VALUE_COERCIONS[renamed];
      out[renamed] = coerce === undefined ? value : coerce(value);
      continue;
    }
    if (KNOWN_OUTPUT_KEYS.has(key)) {
      const coerce = VALUE_COERCIONS[key];
      out[key] = coerce === undefined ? value : coerce(value);
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
