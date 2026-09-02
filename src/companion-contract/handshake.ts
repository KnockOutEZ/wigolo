import type { BrokerGrant } from './broker.js';

export const COMPANION_CONTRACT_VERSION = '1.0.0' as const;

/**
 * The HTTP route the pairing exchange rides, on the EXTERNAL core's daemon. This is the one wire whose
 * server is core rather than the companion: the app opens it, the daemon answers, and the answer carries
 * the broker grant every later op bears. The address belongs to the wire for the same reason the op set
 * does — a disagreement about it is a 404, and a 404 at the app looks exactly like "no daemon running",
 * which is the one thing pairing exists to tell apart.
 */
export const PAIRING_ROUTE = '/companion/pair';

export interface CompanionHello {
  contractVersion: string;
  schemaHead: number;
  capabilities: readonly string[];
}

export interface CompanionHelloApp extends CompanionHello {
  minSchemaHead: number;
}

export type HandshakeRefusal =
  | {
      ok: false;
      reason: 'contract_major_mismatch';
      hint: 'update_wigolo' | 'update_studio';
    }
  | {
      ok: false;
      reason: 'schema_too_old';
      hint: 'update_wigolo';
    };

export type HandshakeResult = { ok: true } | HandshakeRefusal;

function contractMajor(version: string): number {
  return Number.parseInt(version.split('.', 1)[0] ?? '', 10);
}

export function evaluateHandshake(
  external: CompanionHello,
  app: CompanionHelloApp,
): HandshakeResult {
  const externalMajor = contractMajor(external.contractVersion);
  const appMajor = contractMajor(app.contractVersion);

  if (externalMajor !== appMajor) {
    return {
      ok: false,
      reason: 'contract_major_mismatch',
      hint: externalMajor < appMajor ? 'update_wigolo' : 'update_studio',
    };
  }

  if (external.schemaHead < app.minSchemaHead) {
    return {
      ok: false,
      reason: 'schema_too_old',
      hint: 'update_wigolo',
    };
  }

  return { ok: true };
}

/** What the app sends to {@link PAIRING_ROUTE}: its own hello, including the schema head it requires. */
export type PairingRequest = CompanionHelloApp;

/**
 * What the daemon answers. The success arm carries BOTH the grant and the external core's own hello, so
 * the app can record the head its grant was issued against without a second round-trip — that head is
 * what makes a later skew a revocation reason rather than a silent tolerance.
 */
export type PairingResponse =
  | { ok: true; external: CompanionHello; grant: BrokerGrant }
  | HandshakeRefusal;

/** True for a well-formed pairing refusal — the reason must be one the handshake can actually produce. */
export function isHandshakeRefusal(value: unknown): value is HandshakeRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ok?: unknown; reason?: unknown; hint?: unknown };
  if (v.ok !== false) return false;
  if (v.reason !== 'contract_major_mismatch' && v.reason !== 'schema_too_old') return false;
  return v.hint === 'update_wigolo' || v.hint === 'update_studio';
}
