import { MODES, DEPRECATED_MODES, type Mode, type DeprecatedMode } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('mode');

const DEPRECATION_MAP: Record<DeprecatedMode, Mode> = {
  fast: 'cache',
  balanced: 'default',
  deep: 'default',
};

export function assertMode(value: unknown): asserts value is Mode | DeprecatedMode | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    throw new Error(`Invalid mode: ${JSON.stringify(value)}. Valid: ${MODES.join(', ')}`);
  }
  const all = [...MODES, ...DEPRECATED_MODES] as readonly string[];
  if (!all.includes(value)) {
    throw new Error(`Invalid mode: ${JSON.stringify(value)}. Valid: ${MODES.join(', ')}`);
  }
}

export function resolveMode(value: unknown): Mode {
  assertMode(value);
  if (value === undefined) return 'default';
  if ((DEPRECATED_MODES as readonly string[]).includes(value as string)) {
    const dep = value as DeprecatedMode;
    const next = DEPRECATION_MAP[dep];
    log.warn(`mode '${dep}' deprecated, use '${next === 'cache' ? 'cache' : "no mode or 'default'"}'`);
    return next;
  }
  return value as Mode;
}
