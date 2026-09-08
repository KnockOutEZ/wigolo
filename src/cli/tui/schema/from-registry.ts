/**
 * The bridge from core's config-key registry to a TUI `FieldDef`.
 *
 * A category file declares only what is genuinely presentation — label, help,
 * option labels, slider bounds, visibility. The identifier a surface prints,
 * the env var it propagates, and the default it shows all come from
 * `CONFIG_KEYS`, so `wigolo config --plain`, `--set` and the agent env block
 * cannot disagree with `getConfig()`.
 *
 * `field()` throws on an unknown settings key. That is deliberate: the catalog
 * is imported at module load, so a typo or a key that was never registered
 * fails immediately instead of printing a setting nothing reads.
 */
import { configKeyBySettingsKey, configKeyIdentifier, type ConfigKeyDef } from '../../../config.js';
import type { FieldDef, FieldKind, FieldOption } from './types.js';

/** The widget a registry kind renders as, unless the category overrides it. */
function defaultWidget(def: ConfigKeyDef): FieldKind {
  if (def.secret === true || def.kind === 'secret') return 'masked';
  if (def.kind === 'path') return 'path';
  if (def.kind === 'number') return 'number';
  if (def.kind === 'boolean') return 'toggle';
  if (def.kind === 'string-list') return 'multiselect';
  return def.enumValues ? 'select' : 'text';
}

/** Presentation-only parts of a field. Everything else comes from the registry. */
export interface FieldPresentation {
  label: string;
  /** Override the widget the registry kind implies (e.g. a free-text enum). */
  kind?: FieldKind;
  help?: string;
  /**
   * Option rows. Values are checked against the registry's `enumValues` when
   * it declares them, so a picker can never offer a value the resolver rejects.
   */
  options?: ReadonlyArray<FieldOption>;
  min?: number;
  max?: number;
  propagateToAgents?: boolean;
  visible?: FieldDef['visible'];
  validate?: FieldDef['validate'];
  futureNote?: string;
}

export function field(settingsKey: string, ui: FieldPresentation): FieldDef {
  const def = configKeyBySettingsKey(settingsKey);
  if (!def) {
    throw new Error(
      `Config key '${settingsKey}' is not in CONFIG_KEYS. Register it in src/config.ts — a surface must not name a key the resolver does not know.`,
    );
  }

  if (ui.options && def.enumValues) {
    const allowed = new Set(def.enumValues);
    const stray = ui.options.map((o) => o.value).filter((v) => !allowed.has(v));
    if (stray.length > 0) {
      throw new Error(
        `Config key '${settingsKey}' offers ${stray.join(', ')}, which is outside its registered values (${def.enumValues.join(', ')}).`,
      );
    }
  }

  const kind = ui.kind ?? defaultWidget(def);

  return {
    key: configKeyIdentifier(def),
    settingsPath: def.settingsKey,
    envVar: def.envVar,
    legacyKeys: def.legacyKeys,
    label: ui.label,
    kind,
    // A masked field shows a placeholder, never a value — carrying a default
    // through would print one. A sentinel default is withheld for the opposite
    // reason: the editor persists the value it starts from, so pre-filling one
    // would let a user save a placeholder the resolver only ever substitutes.
    default: kind === 'masked' || def.sentinelDefault === true ? undefined : def.default,
    defaultDisplay: def.defaultDisplay,
    ...(ui.help === undefined ? {} : { help: ui.help }),
    ...(ui.options === undefined ? {} : { options: ui.options }),
    ...(ui.min === undefined ? {} : { min: ui.min }),
    ...(ui.max === undefined ? {} : { max: ui.max }),
    ...(ui.propagateToAgents === undefined ? {} : { propagateToAgents: ui.propagateToAgents }),
    ...(ui.visible === undefined ? {} : { visible: ui.visible }),
    ...(ui.validate === undefined ? {} : { validate: ui.validate }),
    ...(ui.futureNote === undefined ? {} : { futureNote: ui.futureNote }),
    ...(def.secret === true ? { secret: true as const } : {}),
  };
}
