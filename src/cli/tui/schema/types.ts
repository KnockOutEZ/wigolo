export type FieldKind =
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'toggle'
  | 'masked'
  | 'path'
  | 'readonly';

export interface Ctx {
  current: Readonly<Record<string, unknown>>;
  pending: Readonly<Record<string, unknown>>;
}

export interface FieldOption {
  value: string;
  label: string;
  hint?: string;
}

export interface FieldDef {
  /**
   * The identifier this field is printed and accepted under: the env var when
   * one resolves the key, the settings key when none does. Sourced from
   * `CONFIG_KEYS` via `field()` — never written by hand.
   */
  key: string;
  settingsPath: string;
  /**
   * The env var the resolver reads for this key, or `null` when none does.
   * `null` means the value must not be propagated into an agent's env block:
   * writing a name nothing reads is what the shipped catalog did.
   */
  envVar?: string | null;
  /** Identifiers an older build accepted for this key. Accepted, never printed. */
  legacyKeys?: readonly string[];
  label: string;
  kind: FieldKind;
  help?: string;
  default?: unknown;
  /** How to render `default` when the bare value would mislead. */
  defaultDisplay?: string;
  options?: ReadonlyArray<FieldOption>;
  min?: number;
  max?: number;
  secret?: true;
  propagateToAgents?: boolean;
  visible?: (ctx: Ctx) => boolean;
  validate?: (v: unknown) => string | null;
  futureNote?: string;
}

export type CategoryId =
  | 'browser'
  | 'search'
  | 'llm'
  | 'agents'
  | 'cache'
  | 'advanced';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  description: string;
  fields: ReadonlyArray<FieldDef>;
  groups?: ReadonlyArray<{ label: string; fieldKeys: string[] }>;
}
