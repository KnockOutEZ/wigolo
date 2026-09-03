/**
 * The telemetry off switch — a leaf module with no imports.
 *
 * `src/config.ts` reads this to resolve `telemetryEnabled`, so it must not import
 * anything that imports config back (the same reason `src/account/constants.ts` is a
 * leaf). Keeping it dependency-free also means the switch can be evaluated before any
 * subsystem has initialised.
 *
 * Precedence is env > persisted > default, and the default is ON: 0.3.0 ships telemetry
 * opt-OUT, not opt-in.
 */

/** Environment variable that turns telemetry off for a single run. */
export const TELEMETRY_ENV = 'WIGOLO_TELEMETRY';

/** Persisted settings key backing the same switch (flat camelCase, like the whole catalog). */
export const TELEMETRY_SETTINGS_KEY = 'telemetryEnabled';

/**
 * Retired free-POST endpoint override. Deprecated for one release: setting it warns and
 * changes nothing. See {@link warnDeprecatedEndpointEnv} in `./index.ts`.
 */
export const TELEMETRY_ENDPOINT_ENV = 'WIGOLO_TELEMETRY_ENDPOINT';

/**
 * The spellings that mean OFF, matched trimmed + lowercased.
 *
 * ⚠ THIS DELIBERATELY BYPASSES `envBool` (`src/config.ts`), AND THAT IS THE WHOLE POINT.
 * `envBool` returns `envVal.toLowerCase() !== 'false' && envVal !== '0'` — it recognises
 * exactly `false` and `0`, so `WIGOLO_TELEMETRY=off` and `=no` would parse as ON and the
 * documented off switch would be a silent no-op. Widening `envBool` itself is not the fix:
 * every knob in the catalog reads through it, so `off`/`no` would flip meaning for values
 * already set in the field. The in-tree precedent for a dedicated parser is
 * `AUTO_LAUNCH_OFF_VALUES` (`src/companion/auto-launch.ts`), which bypasses `envBool` for the
 * same measured reason. Recorded as A-212-5.
 *
 * `envBool` also does not trim, and a value that arrived with the shell's whitespace still
 * attached is the same stated intent.
 *
 * KEEP BYTE-IDENTICAL to that set and to `SKIP_OFF_VALUES` (`scripts/prepare-build.mjs`). This one
 * carried `no` from the start and the other two did not, and that split is precisely how
 * `WIGOLO_SKIP_PREPARE=no` came to mean SKIP (A-202-1). `tests/unit/prepare-build.test.ts` now
 * asserts all three are equal, so widening any one of them alone reds.
 */
export const TELEMETRY_OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);

/**
 * Read the env switch.
 *
 * @returns `false` for any off spelling, `true` for any other set value, `undefined` when
 * the variable is unset — which is what lets the persisted layer speak next.
 */
export function parseTelemetryEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  return !TELEMETRY_OFF_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Resolve the switch across all three layers: env beats persisted, persisted beats the
 * default-on. A persisted value of any non-boolean type is ignored rather than coerced —
 * a corrupt settings file must not be able to turn telemetry on OR off by accident.
 */
export function resolveTelemetryEnabled(raw: string | undefined, persisted: unknown): boolean {
  const fromEnv = parseTelemetryEnv(raw);
  if (fromEnv !== undefined) return fromEnv;
  if (typeof persisted === 'boolean') return persisted;
  return true;
}
