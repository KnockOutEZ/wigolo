import { vi } from 'vitest';
import type { BrokerClient } from '../../src/main/broker-client';

/**
 * A fake DB broker for host tests — satisfies the `Pick<BrokerClient,'call'>` host dep with sensible
 * per-method defaults and a spy so tests can assert routing. Pass `handlers` to override a method (e.g.
 * to drive it against real createBrokerHandlers, to reject/hang for the §11 resilience cases, or to
 * record args). Keeps every existing host test green when the required `broker` dep landed (mock-mirror).
 */
export function makeFakeBroker(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>> = {},
): Pick<BrokerClient, 'call'> & { call: ReturnType<typeof vi.fn> } {
  const defaults: Record<string, (p: unknown) => unknown> = {
    capture: () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
    persistSessionFetch: () => ({ id: 1, inserted: true, contentHash: 'h' }),
    persistMark: () => ({ id: 1, inserted: true, contentHash: 'h' }),
    persistExtraction: () => ({ id: 1, inserted: true, contentHash: 'h' }),
    persistComment: () => ({ id: 1, inserted: true, contentHash: 'h' }),
    persistScreenshot: () => ({ id: 1, inserted: true, contentHash: 'h' }),
    listArtifacts: () => [],
    listComments: () => [],
    findSimilar: () => ({ results: [], method: 'fts5' }),
    persistAudit: () => ({ seq: 1 }),
    // K34 — the flow sidecar's broker seam. Present here because the host now calls both on every
    // recordable act, and an absent handler makes this fake THROW, which the recorder then swallows: the
    // host tests would stay green while the app recorded nothing. That is the exact failure K34 is.
    flowMaxSeq: () => ({ seq: 0 }),
    recordFlowStep: (p: unknown) => ({ ok: true, step: (p as { step: unknown }).step }),
    listAudit: () => [],
    synthesizeSession: () => ({ empty: true }),
  };
  const merged = { ...defaults, ...handlers };
  const call = vi.fn(async (method: string, params?: unknown) => {
    const fn = merged[method];
    if (!fn) throw new Error(`fake-broker: no handler for ${method}`);
    return fn(params);
  });
  // The generic `call<T>` signature can't be inferred from a plain mock — bridge it (test-only).
  return { call } as unknown as Pick<BrokerClient, 'call'> & { call: ReturnType<typeof vi.fn> };
}
