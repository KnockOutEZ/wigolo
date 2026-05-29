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
  key: string;
  settingsPath: string;
  label: string;
  kind: FieldKind;
  help?: string;
  default?: unknown;
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
