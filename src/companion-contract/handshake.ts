export const COMPANION_CONTRACT_VERSION = '1.0.0' as const;

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
