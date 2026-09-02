/**
 * The detected-tier capability handshake (SD2 mini-spec §2).
 *
 * The MCP `initialize` handshake already carries `clientInfo {name, version}`, so detection is free
 * on day one and works with every harness. This module turns that badge into two things and only
 * two: a CAPABILITY SET, which is what every downstream branch is allowed to read (law 5), and a
 * PHRASING KEY, which may reword an imperative and may change nothing else.
 *
 * **The detected tier grants no capability to anyone.** MCP is a pull transport and `clientInfo` is
 * self-reported, so it cannot prove push, mid-flight interrupt, resume or identity. An unmapped
 * client therefore behaves identically to a mapped one — the default only ever under-promises
 * (A-51-9). SD8's adopted/wrapped tiers are where a harness earns capabilities, against evidence.
 *
 * Deliberately free of heavy imports: `studio-mcp-server.ts` hosts this on the Electron main, where
 * better-sqlite3 cannot load at all, so the run-log side of the handshake lives in the separate
 * `run-client-attach.ts` and nothing here reaches the store.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Actor, ClientInfo, RunEventInput } from '../studio/run-store.js';

/** §2.1, verbatim. */
export type Capability = 'push' | 'narrate' | 'reasoning' | 'interrupt' | 'resume' | 'identity';

export const ALL_CAPABILITIES: readonly Capability[] = Object.freeze([
  'push',
  'narrate',
  'reasoning',
  'interrupt',
  'resume',
  'identity',
] as const);

/** The only thing a client name buys (§2.2). `mcp-tools` may name tools; `generic` may not. */
export type PhrasingKey = 'mcp-tools' | 'generic';

export interface ClientProfile {
  /** Only tier there is until SD8. Present so a later tier cannot be mistaken for this one. */
  readonly tier: 'detected';
  /** Self-reported, absent when the handshake carried nothing usable. Never load-bearing. */
  readonly client?: ClientInfo;
  readonly phrasing: PhrasingKey;
  readonly capabilities: readonly Capability[];
}

/**
 * §2.2's table. Every row lands on `mcp-tools` today — the rows are kept distinct anyway because
 * SD8 gives each its own ceiling, and a collapsed table would have to be rebuilt to express that.
 */
export const DETECTED_CLIENT_TABLE: readonly { readonly prefix: string; readonly phrasing: PhrasingKey }[] =
  Object.freeze([
    { prefix: 'claude-code', phrasing: 'mcp-tools' },
    { prefix: 'claude', phrasing: 'mcp-tools' },
    { prefix: 'cursor', phrasing: 'mcp-tools' },
    { prefix: 'windsurf', phrasing: 'mcp-tools' },
    { prefix: 'cline', phrasing: 'mcp-tools' },
    { prefix: 'codex', phrasing: 'mcp-tools' },
    { prefix: 'gemini', phrasing: 'mcp-tools' },
  ] as const);

export const DEFAULT_PHRASING: PhrasingKey = 'generic';

/** The tier's whole grant, shared by every profile so no caller can widen one in place. */
const NO_CAPABILITIES: readonly Capability[] = Object.freeze([]);

/**
 * The badge is wire input on its way into an append-only log, so it is capped at the same width the
 * REST create path caps `driver.client` at. Declared here because this module is the one both
 * entry points share; `rest/runs.ts` re-exports it rather than keeping a second number.
 */
export const MAX_CLIENT_FIELD_CHARS = 200;

/** What an absent, malformed or unmapped handshake resolves to. Pull only, and never an error. */
export const UNKNOWN_CLIENT_PROFILE: ClientProfile = Object.freeze({
  tier: 'detected',
  phrasing: DEFAULT_PHRASING,
  capabilities: NO_CAPABILITIES,
});

function badgeField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_CLIENT_FIELD_CHARS) : undefined;
}

/**
 * Rebuilt rather than passed through, exactly as `run-store.ts` rebuilds a driver badge: this
 * object is serialized into the run log, so anything else the caller hung on it would be durable.
 * A half-filled badge is dropped for the same reason the store drops one — a reader takes the
 * field for a known shape.
 */
function badgeOf(raw: unknown): ClientInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as { name?: unknown; version?: unknown };
  const name = badgeField(c.name);
  const version = badgeField(c.version);
  return name && version ? { name, version } : undefined;
}

function phrasingFor(name: string | undefined): PhrasingKey {
  if (!name) return DEFAULT_PHRASING;
  const lowered = name.toLowerCase();
  return DETECTED_CLIENT_TABLE.find((row) => lowered.startsWith(row.prefix))?.phrasing ?? DEFAULT_PHRASING;
}

/**
 * The whole mapping. `raw` is whatever `Server.getClientVersion()` returned — which is `undefined`
 * before `initialize` completes and is attacker-shaped after it, since a client names itself.
 */
export function profileClient(raw: unknown): ClientProfile {
  const client = badgeOf(raw);
  // Phrasing reads the name even when the badge was dropped for a missing version: a half-filled
  // handshake still identifies its harness, and phrasing is the one thing the name is allowed to buy.
  const declaredName = badgeField((raw as { name?: unknown } | undefined)?.name);
  const phrasing = phrasingFor(client?.name ?? declaredName);
  if (!client && phrasing === DEFAULT_PHRASING) return UNKNOWN_CLIENT_PROFILE;
  return Object.freeze({
    tier: 'detected' as const,
    ...(client ? { client } : {}),
    phrasing,
    capabilities: NO_CAPABILITIES,
  });
}

/** The ONLY sanctioned branch on a client. Reading `profile.client.name` to decide is the anti-goal. */
export function hasCapability(profile: ClientProfile, capability: Capability): boolean {
  return profile.capabilities.includes(capability);
}

/**
 * The slice of an MCP `Server` the handshake needs. Structural rather than the SDK type so this
 * module stays import-free and the Electron-hosted gateway can load it (see the file header).
 */
export interface HandshakeConnection {
  oninitialized?: () => void;
  getClientVersion(): unknown;
}

/**
 * Keyed by the connection object, which is one `Server` per transport session, so the entry dies
 * with the session and nothing has to remember to evict it.
 */
const profiles = new WeakMap<object, ClientProfile>();

/**
 * Resolves the profile when `initialize` completes and stores it on the connection.
 *
 * `oninitialized` rather than a per-call read because the badge is fixed for the life of the
 * session: resolving it once means the mapping table is consulted once, and means a call that
 * somehow arrives mid-handshake cannot see a half-resolved profile. Any handler already installed
 * is preserved — this is a hook, not an owner of the slot.
 */
export function attachCapabilityHandshake(connection: HandshakeConnection): () => ClientProfile {
  const prior = connection.oninitialized;
  connection.oninitialized = () => {
    profiles.set(connection, profileClient(connection.getClientVersion()));
    prior?.();
  };
  return () => connectionProfile(connection);
}

/** The safe default until `initialize` lands, and for any object that never handshook at all. */
export function connectionProfile(connection: object): ClientProfile {
  return profiles.get(connection) ?? UNKNOWN_CLIENT_PROFILE;
}

const ambient = new AsyncLocalStorage<ClientProfile>();

/**
 * Scopes a connection's profile over the work it dispatches. Async-local rather than a module
 * variable because one process serves many connections concurrently, and a shared slot would hand
 * whichever call resolved last its neighbour's profile.
 */
export function withClientProfile<T>(profile: ClientProfile, fn: () => T): T {
  return ambient.run(profile, fn);
}

/**
 * The seam a result-phrasing site reads. Outside any connection — a CLI verb, a scheduled check,
 * a test — the honest answer is the safe default, not a throw: nothing is worse off for being
 * phrased generically.
 */
export function currentClientProfile(): ClientProfile {
  return ambient.getStore() ?? UNKNOWN_CLIENT_PROFILE;
}

/** The run-log name for an attach. `tab.attached` is a different subject and already taken. */
export const CLIENT_ATTACHED = 'client.attached';

/**
 * The durable record of "this client, with these capabilities, attached to this run". The payload
 * is the profile whole, so a replay or an audit can answer what the client could do at the time
 * without re-deriving it from a table that will have moved by then.
 */
export function clientAttachedEvent(profile: ClientProfile): RunEventInput {
  const actor: Actor = { kind: 'agent', ...(profile.client ? { client: profile.client } : {}) };
  return {
    actor,
    type: CLIENT_ATTACHED,
    payload: {
      tier: profile.tier,
      phrasing: profile.phrasing,
      capabilities: [...profile.capabilities],
      ...(profile.client ? { client: profile.client } : {}),
    },
  };
}
