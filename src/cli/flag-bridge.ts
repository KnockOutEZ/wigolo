import { lstatSync, readFileSync } from 'node:fs';
import { TOOL_SCHEMAS, type ToolSchema } from '../server/tool-schemas.js';
import type { ToolName } from '../instructions.js';

/**
 * Schema-driven CLI flag bridge. The JSON schemas in `src/server/tool-schemas.ts`
 * are the single source of truth for every tool's parameters; this module derives
 * `--flag` names, coercion rules, and the boolean-flag set from them, then layers
 * a curated set of shorthand aliases on top. It does NOT own any tool behaviour —
 * it only turns raw string flags into a typed tool-input object.
 */

/** Coercion kinds inferred from a JSON-schema property. */
export type FlagKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'array-string'
  | 'array-object'
  | 'object'
  | 'oneof-string-array';

export interface FlagSpec {
  /** Kebab-case flag name (no leading dashes). */
  flag: string;
  /** Canonical schema property key this flag sets. */
  key: string;
  kind: FlagKind;
  /** Allowed values for `kind === 'enum'`. */
  enumValues?: string[];
  /** Schema property description, for help rendering. */
  description?: string;
}

/** Executor command name → canonical tool-schema name. */
const COMMAND_TO_TOOL: Record<string, ToolName> = {
  search: 'search',
  fetch: 'fetch',
  crawl: 'crawl',
  extract: 'extract',
  cache: 'cache',
  'find-similar': 'find_similar',
  find_similar: 'find_similar',
  research: 'research',
  agent: 'agent',
  diff: 'diff',
  watch: 'watch',
};

const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB

/**
 * Properties that are NOT reachable via a derived `--flag` because they are
 * mapped some other way (positional, verb, subcommand, or curated string-wrap).
 * Keyed by canonical tool name. The parity test pins the same set.
 */
export const ROUND_TRIP_EXCLUSIONS: Record<string, ReadonlySet<string>> = {
  search: new Set(['query']), // positional
  fetch: new Set(['url']), // positional
  crawl: new Set(['url']), // positional
  research: new Set(['question']), // positional
  agent: new Set(['prompt']), // positional
  extract: new Set(['url']), // positional (html still reachable via --html)
  find_similar: new Set(['url', 'concept']), // positional
  cache: new Set(['query', 'clear', 'stats']), // positional query + subcommands
  watch: new Set(['action']), // verb-mapped
  diff: new Set(['old', 'new']), // curated string-wrap; schema objects excluded
};

/**
 * Curated aliases: shorthand `--flag` → canonical schema key. These WIN over a
 * schema-derived flag of the same kebab name. Some aliases are tool-scoped
 * (e.g. `--depth` means max_depth for crawl but depth for research).
 */
interface Alias {
  key: string;
  kind: FlagKind;
  /** Fixed boolean value for negation aliases (e.g. --no-content → false). */
  fixedBoolean?: boolean;
  /** Restrict this alias to specific tools. */
  tools?: ReadonlySet<string>;
}

function curatedAliases(tool: ToolName): Record<string, Alias> {
  const all: Record<string, Alias> = {
    limit: { key: 'max_results', kind: 'number' },
    domains: { key: 'include_domains', kind: 'array-string' },
    'exclude-domains': { key: 'exclude_domains', kind: 'array-string' },
    from: { key: 'from_date', kind: 'string' },
    'from-date': { key: 'from_date', kind: 'string' },
    to: { key: 'to_date', kind: 'string' },
    'to-date': { key: 'to_date', kind: 'string' },
    'no-content': { key: 'include_content', kind: 'boolean', fixedBoolean: false },
    'no-cache': { key: 'include_cache', kind: 'boolean', fixedBoolean: false },
    'no-web': { key: 'include_web', kind: 'boolean', fixedBoolean: false },
    selector: { key: 'css_selector', kind: 'string' },
    urls: { key: 'urls', kind: 'array-string' },
    'max-pages': { key: 'max_pages', kind: 'number' },
    'max-time': { key: 'max_time_ms', kind: 'number' },
    'max-time-ms': { key: 'max_time_ms', kind: 'number' },
    interval: { key: 'interval_seconds', kind: 'number' },
    'interval-seconds': { key: 'interval_seconds', kind: 'number' },
    notify: { key: 'notification', kind: 'string' },
    'url-pattern': { key: 'url_pattern', kind: 'string' },
    'max-sources': { key: 'max_sources', kind: 'number' },
    'max-chars': { key: 'max_chars', kind: 'number' },
    section: { key: 'section', kind: 'string' },
    multiple: { key: 'multiple', kind: 'boolean' },
    screenshot: { key: 'screenshot', kind: 'boolean' },
    output: { key: 'output', kind: 'string' },
    granularity: { key: 'granularity', kind: 'string' },
    'job-id': { key: 'job_id', kind: 'string' },
    id: { key: 'job_id', kind: 'string' },
  };

  // `--depth` is tool-scoped: crawl → max_depth (number). For research, the
  // schema property is literally `depth` (an enum), so the schema-derived flag
  // handles it directly with enum validation — no curated alias needed.
  if (tool === 'crawl') {
    all.depth = { key: 'max_depth', kind: 'number' };
  }

  return all;
}

function kebab(name: string): string {
  return name.replace(/_/g, '-');
}

type SchemaProp = {
  type?: string;
  enum?: string[];
  oneOf?: Array<{ type?: string }>;
  items?: { type?: string };
  description?: string;
};

function classify(prop: SchemaProp): FlagKind {
  if (Array.isArray(prop.oneOf)) {
    const types = prop.oneOf.map((v) => v.type);
    if (types.includes('string') && types.includes('array')) {
      return 'oneof-string-array';
    }
    return 'string';
  }
  if (Array.isArray(prop.enum)) return 'enum';
  switch (prop.type) {
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    case 'array':
      return prop.items?.type === 'object' ? 'array-object' : 'array-string';
    default:
      return 'string';
  }
}

/** Derive one FlagSpec per schema property (kebab flag + coercion kind). */
export function toolFlagSpecs(command: string): FlagSpec[] {
  const tool = COMMAND_TO_TOOL[command];
  if (!tool) return [];
  const schema: ToolSchema = TOOL_SCHEMAS[tool];
  const specs: FlagSpec[] = [];
  for (const [key, rawProp] of Object.entries(schema.properties)) {
    const prop = rawProp as SchemaProp;
    const kind = classify(prop);
    specs.push({
      flag: kebab(key),
      key,
      kind,
      enumValues: Array.isArray(prop.enum) ? prop.enum : undefined,
      description: prop.description,
    });
  }
  return specs;
}

/**
 * Boolean flags that take NO value — the parser must not let them swallow the
 * next positional token. Union of: schema booleans, their `no-` variants, and
 * the curated boolean aliases that apply to this tool.
 */
export function booleanFlagsFor(command: string): Set<string> {
  const set = new Set<string>();
  for (const spec of toolFlagSpecs(command)) {
    if (spec.kind === 'boolean') {
      set.add(spec.flag);
      set.add(`no-${spec.flag}`);
    }
  }
  const tool = COMMAND_TO_TOOL[command];
  if (tool) {
    const schemaKeys = new Set(toolFlagSpecs(tool).map((s) => s.key));
    for (const [flag, alias] of Object.entries(curatedAliases(tool))) {
      if (alias.kind !== 'boolean') continue;
      if (schemaKeys.has(alias.key) || alias.fixedBoolean !== undefined) set.add(flag);
    }
  }
  return set;
}

// ---- Levenshtein (hand-rolled, no dependency) ------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function nearestFlag(unknown: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3; // strictly ≤ 2 qualifies
  for (const cand of known) {
    const d = levenshtein(unknown, cand);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return bestDist <= 2 ? best : undefined;
}

// ---- @file reader ----------------------------------------------------------

/**
 * Resolve an `@file` reference to its text, enforcing regular-file + ≤1 MiB.
 * Returns either the text or a one-line error that NEVER echoes file content.
 */
function readAtFile(flag: string, path: string): { text?: string; error?: string } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { error: `--${flag}: cannot read file ${path}` };
  }
  if (!stat.isFile()) {
    return { error: `--${flag}: not a regular file ${path}` };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return { error: `--${flag}: file ${path} exceeds the 1 MiB limit` };
  }
  try {
    return { text: readFileSync(path, 'utf-8') };
  } catch {
    return { error: `--${flag}: cannot read file ${path}` };
  }
}

/** Resolve an inline-or-@file value to raw text (never leaks file content). */
function resolveValue(flag: string, raw: string): { text?: string; error?: string } {
  if (raw.startsWith('@')) {
    return readAtFile(flag, raw.slice(1));
  }
  return { text: raw };
}

// ---- Coercion --------------------------------------------------------------

interface Resolved {
  key: string;
  kind: FlagKind;
  fixedBoolean?: boolean;
}

/**
 * Map a raw kebab flag to its canonical key + coercion kind, honouring curated
 * aliases (which WIN over schema-derived flags) and `no-` boolean negation of
 * schema booleans. Returns undefined for an unknown flag.
 */
function resolveFlag(tool: ToolName, flag: string): Resolved | undefined {
  const specs = toolFlagSpecs(tool);
  const bySchemaFlag = new Map(specs.map((s) => [s.flag, s]));
  const schemaKeys = new Set(specs.map((s) => s.key));
  const aliases = curatedAliases(tool);
  const alias = aliases[flag];
  // A curated alias wins ONLY when its target key exists in this tool's schema
  // OR it is a synthetic negation alias (no-content/no-cache/no-web) whose key
  // is a real boolean. Otherwise the alias is inert here and a same-named schema
  // flag (e.g. cache `limit`, watch `selector`) takes over.
  if (alias && (schemaKeys.has(alias.key) || alias.fixedBoolean !== undefined)) {
    return { key: alias.key, kind: alias.kind, fixedBoolean: alias.fixedBoolean };
  }
  const direct = bySchemaFlag.get(flag);
  if (direct) {
    return { key: direct.key, kind: direct.kind };
  }
  // `no-<schemaBoolean>` negation.
  if (flag.startsWith('no-')) {
    const base = bySchemaFlag.get(flag.slice(3));
    if (base && base.kind === 'boolean') {
      return { key: base.key, kind: 'boolean', fixedBoolean: false };
    }
  }
  return undefined;
}

/** All known flag names (schema-derived + curated aliases + no- variants). */
function knownFlagNames(tool: ToolName): string[] {
  const names = new Set<string>();
  const specs = toolFlagSpecs(tool);
  const schemaKeys = new Set(specs.map((s) => s.key));
  for (const spec of specs) {
    names.add(spec.flag);
    if (spec.kind === 'boolean') names.add(`no-${spec.flag}`);
  }
  for (const [flag, alias] of Object.entries(curatedAliases(tool))) {
    if (schemaKeys.has(alias.key) || alias.fixedBoolean !== undefined) names.add(flag);
  }
  return [...names];
}

function coerceEnum(
  flag: string,
  key: string,
  value: string,
  enumValues: string[],
): { value?: unknown; error?: string } {
  if (enumValues.includes(value)) return { value };
  return { error: `--${flag}: '${value}' is not valid (allowed: ${enumValues.join(', ')})` };
}

/**
 * Coerce a tool's raw string flags into a typed tool-input object per the
 * schema-driven matrix. Unknown flags produce an error (with a nearest-match
 * suggestion when levenshtein distance ≤ 2). Curated aliases win over
 * schema-derived flags of the same name.
 */
export function coerceFlags(
  command: string,
  flags: Record<string, string>,
): { input: Record<string, unknown>; errors: string[] } {
  const tool = COMMAND_TO_TOOL[command];
  const input: Record<string, unknown> = {};
  const errors: string[] = [];
  if (!tool) return { input, errors };

  const enumByKey = new Map(
    toolFlagSpecs(tool)
      .filter((s) => s.kind === 'enum')
      .map((s) => [s.key, s.enumValues ?? []]),
  );

  for (const [flag, rawValue] of Object.entries(flags)) {
    const resolved = resolveFlag(tool, flag);
    if (!resolved) {
      const near = nearestFlag(flag, knownFlagNames(tool));
      errors.push(
        `unknown flag --${flag} for ${command}` +
          (near ? ` — did you mean --${near}?` : ''),
      );
      continue;
    }

    const { key, kind, fixedBoolean } = resolved;

    switch (kind) {
      case 'boolean': {
        if (fixedBoolean !== undefined) {
          input[key] = fixedBoolean;
        } else {
          input[key] = rawValue !== 'false';
        }
        break;
      }
      case 'number': {
        const n = Number(rawValue);
        if (Number.isNaN(n)) {
          errors.push(`--${flag}: '${rawValue}' is not a number`);
        } else {
          input[key] = n;
        }
        break;
      }
      case 'enum': {
        const allowed = enumByKey.get(key) ?? [];
        const r = coerceEnum(flag, key, rawValue, allowed);
        if (r.error) errors.push(r.error);
        else input[key] = r.value;
        break;
      }
      case 'array-string': {
        input[key] = rawValue
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      }
      case 'array-object': {
        const resolvedVal = resolveValue(flag, rawValue);
        if (resolvedVal.error) {
          errors.push(resolvedVal.error);
          break;
        }
        try {
          const parsed = JSON.parse(resolvedVal.text ?? '');
          if (!Array.isArray(parsed)) {
            errors.push(`--${flag}: expected a JSON array of objects`);
          } else {
            input[key] = parsed;
          }
        } catch {
          errors.push(
            `--${flag}: expected inline JSON or @file (an array of objects), not comma-separated values`,
          );
        }
        break;
      }
      case 'object': {
        const resolvedVal = resolveValue(flag, rawValue);
        if (resolvedVal.error) {
          errors.push(resolvedVal.error);
          break;
        }
        try {
          input[key] = JSON.parse(resolvedVal.text ?? '');
        } catch {
          errors.push(`--${flag}: expected inline JSON or @file (a JSON object)`);
        }
        break;
      }
      case 'oneof-string-array': {
        const trimmed = rawValue.trim();
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            input[key] = Array.isArray(parsed) ? parsed : rawValue;
          } catch {
            input[key] = rawValue;
          }
        } else {
          input[key] = rawValue;
        }
        break;
      }
      case 'string':
      default:
        input[key] = rawValue;
        break;
    }
  }

  return { input, errors };
}

/**
 * Merge schema-derived bridge output into a curated tool-input object. Keys the
 * executor already set (curated mappings) WIN over bridge-derived values. The
 * one cast-through-unknown lives here so executors stay `as`-free; every tool
 * input is a plain object literal, so this widening is sound.
 */
export function mergeBridged<T>(curated: T, bridged: Record<string, unknown>): T {
  const target = curated as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(bridged)) {
    if (!(k in target)) target[k] = v;
  }
  return curated;
}
