/**
 * The closed event dictionary.
 *
 * The brief's Never list (page content, markdown, query text, full URLs, credentials, file
 * paths) is enforced STRUCTURALLY rather than by review: every prop of every event is an
 * enum member, a boolean, or a registrable domain. There is no free-text prop anywhere in
 * this file, so none of the forbidden values is representable — not "not sent", but
 * unable to be constructed. A-212-6.
 *
 * We ship error CLASSES only, with no message strings at all. That is strictly narrower
 * than the brief's "sanitized message" allowance, and deliberately so: a sanitizer is a
 * predicate that can be wrong, an enum cannot be.
 *
 * Adding an event means adding a union member AND its {@link EVENT_SCHEMA} row. The schema
 * test walks the table and fails if the two ever disagree, or if any prop admits a string
 * that is not a closed enum member or a registrable domain.
 */
import { isRegistrableDomain, type RegistrableDomain } from './domain.js';

/** The ten wigolo tools. A tool outside this list is not reportable. */
export const TOOL_NAMES = [
  'search',
  'fetch',
  'crawl',
  'cache',
  'extract',
  'find_similar',
  'research',
  'agent',
  'diff',
  'watch',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** The dispatch surface a tool call arrived on. */
export const SURFACES = ['mcp', 'rest', 'cli', 'repl'] as const;
export type Surface = (typeof SURFACES)[number];

/** Duration buckets. A bucket, never a millisecond count — see {@link durationBucket}. */
export const DURATION_BUCKETS = ['lt_100ms', 'lt_500ms', 'lt_2s', 'lt_10s', 'lt_60s', 'ge_60s'] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

/** Error classes. No message, sanitized or otherwise, ever accompanies these. */
export const ERROR_CLASSES = [
  'timeout',
  'network',
  'dns',
  'http_4xx',
  'http_5xx',
  'blocked',
  'invalid_input',
  'internal',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Why a fetch was blocked. */
export const BLOCK_SIGNALS = ['challenge', 'http_403', 'tier_ceiling'] as const;
export type BlockSignal = (typeof BLOCK_SIGNALS)[number];

/**
 * Fetch tiers, spelled exactly as `FetchResult.method` spells them (`src/types.ts`), so the
 * instrumentation slice maps them across with an identity and no translation table can
 * drift out of sync with the router.
 */
export const FETCH_TIERS = ['http', 'tls-impersonation', 'browser', 'reddit-api'] as const;
export type FetchTier = (typeof FETCH_TIERS)[number];

/**
 * Search engine ids, as each engine spells its own `name` (`src/search/engines/*`, plus the
 * aggregator backend). `other` is a member on purpose: a new engine added later must
 * degrade to a closed value, never to free text and never to a silently dropped event.
 */
export const ENGINE_IDS = [
  'arxiv',
  'bing',
  'bing_news',
  'brave',
  'brave-image',
  'crates-io',
  'ddg-image',
  'devdocs',
  'duckduckgo',
  'github-code',
  'hn-algolia',
  'lobsters',
  'marginalia',
  'mdn',
  'mojeek',
  'searxng',
  'semantic-scholar',
  'stackoverflow',
  'wikipedia',
  'other',
] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

/** Daemon uptime buckets, emitted at flush time by long-lived processes. */
export const UPTIME_BUCKETS = ['lt_1h', 'lt_8h', 'lt_24h', 'lt_7d', 'ge_7d'] as const;
export type UptimeBucket = (typeof UPTIME_BUCKETS)[number];

/**
 * The dictionary. Every member's `props` is a closed record of literal-union and boolean
 * types — a `string`-typed prop here would be a type error at every construction site AND
 * would fail the schema walk.
 */
export type TelemetryEvent =
  | { name: 'tool.run'; props: { tool: ToolName; surface: Surface; ok: boolean; duration_bucket: DurationBucket } }
  | { name: 'tool.error'; props: { tool: ToolName; surface: Surface; error_class: ErrorClass } }
  | { name: 'fetch.blocked'; props: { domain: RegistrableDomain; signal: BlockSignal } }
  | { name: 'fetch.tier_escalated'; props: { to_tier: FetchTier } }
  | { name: 'search.engine_failure'; props: { engine: EngineId; error_class: ErrorClass } }
  | { name: 'daemon.uptime'; props: { bucket: UptimeBucket } };

// Compile-time tripwire for the Never list. It lives in src/ so the root typecheck always
// evaluates it; tests/ are intentionally outside that compiler project.
type Assert<T extends true> = T;
type FetchBlockedDomain = Extract<TelemetryEvent, { name: 'fetch.blocked' }>['props']['domain'];
export type DomainIsClosed = Assert<string extends FetchBlockedDomain ? false : true>;

export type TelemetryEventName = TelemetryEvent['name'];

/**
 * The kinds a prop may have. There is no `string`/`text`/`freeform` kind, and that absence
 * IS the Never list: `domain` is the only string-valued kind, and it is validated against
 * {@link isRegistrableDomain} rather than accepted as written.
 */
export type PropSpec =
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'domain' };

export type EventSchema = Readonly<Record<TelemetryEventName, Readonly<Record<string, PropSpec>>>>;

/** Runtime mirror of the union above. Kept in lockstep by the schema test. */
export const EVENT_SCHEMA: EventSchema = {
  'tool.run': {
    tool: { kind: 'enum', values: TOOL_NAMES },
    surface: { kind: 'enum', values: SURFACES },
    ok: { kind: 'boolean' },
    duration_bucket: { kind: 'enum', values: DURATION_BUCKETS },
  },
  'tool.error': {
    tool: { kind: 'enum', values: TOOL_NAMES },
    surface: { kind: 'enum', values: SURFACES },
    error_class: { kind: 'enum', values: ERROR_CLASSES },
  },
  'fetch.blocked': {
    domain: { kind: 'domain' },
    signal: { kind: 'enum', values: BLOCK_SIGNALS },
  },
  'fetch.tier_escalated': {
    to_tier: { kind: 'enum', values: FETCH_TIERS },
  },
  'search.engine_failure': {
    engine: { kind: 'enum', values: ENGINE_IDS },
    error_class: { kind: 'enum', values: ERROR_CLASSES },
  },
  'daemon.uptime': {
    bucket: { kind: 'enum', values: UPTIME_BUCKETS },
  },
};

export const EVENT_NAMES = Object.keys(EVENT_SCHEMA) as readonly TelemetryEventName[];

/** PX1 §7 pins the wire-level event-name shape; assert it rather than assume it. */
export const EVENT_NAME_PATTERN = /^[a-z0-9_.]{1,64}$/;

function matchesSpec(spec: PropSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'domain':
      return isRegistrableDomain(value);
  }
}

/**
 * The queue-boundary guard.
 *
 * The types already make a bad event unconstructable in first-party code; this re-checks it
 * at runtime so a value that reached a call site through an `unknown` — or a queue file
 * edited on disk — still cannot put an unlisted name, an unlisted prop, or an unreduced
 * host onto the wire. Unknown props are a rejection, not a silent strip: a stripped event
 * would report a shape nobody wrote.
 */
export function isValidEvent(candidate: unknown): candidate is TelemetryEvent {
  if (candidate === null || typeof candidate !== 'object') return false;
  const record = candidate as { name?: unknown; props?: unknown };
  if (typeof record.name !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(EVENT_SCHEMA, record.name)) return false;
  const schema = EVENT_SCHEMA[record.name as TelemetryEventName];
  if (record.props === null || typeof record.props !== 'object') return false;
  const props = record.props as Record<string, unknown>;
  const seen = Object.keys(props);
  if (seen.length !== Object.keys(schema).length) return false;
  for (const key of seen) {
    const spec = schema[key];
    if (spec === undefined) return false;
    if (!matchesSpec(spec, props[key])) return false;
  }
  return true;
}

/** Milliseconds → bucket. Total over the non-negative reals; a negative reading buckets low. */
export function durationBucket(ms: number): DurationBucket {
  if (!Number.isFinite(ms)) return 'ge_60s';
  if (ms < 100) return 'lt_100ms';
  if (ms < 500) return 'lt_500ms';
  if (ms < 2_000) return 'lt_2s';
  if (ms < 10_000) return 'lt_10s';
  if (ms < 60_000) return 'lt_60s';
  return 'ge_60s';
}

/** Uptime milliseconds → bucket. */
export function uptimeBucket(ms: number): UptimeBucket {
  if (!Number.isFinite(ms)) return 'ge_7d';
  if (ms < 3_600_000) return 'lt_1h';
  if (ms < 8 * 3_600_000) return 'lt_8h';
  if (ms < 24 * 3_600_000) return 'lt_24h';
  if (ms < 7 * 24 * 3_600_000) return 'lt_7d';
  return 'ge_7d';
}
