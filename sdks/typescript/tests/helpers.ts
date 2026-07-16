import type { FetchLike } from '../src/index.js';

/** Scrub every ambient WIGOLO_* env var so tests never inherit host config. */
export function scrubWigoloEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('WIGOLO_')) delete process.env[key];
  }
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface StubResponseInit {
  ok?: boolean;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Build an injectable fetch that records calls and returns a scripted response.
 * `respond` may be a static init or a function of the recorded call.
 */
export function stubFetch(
  respond: StubResponseInit | ((call: RecordedCall) => StubResponseInit),
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    };
    calls.push(call);
    const r = typeof respond === 'function' ? respond(call) : respond;
    const status = r.status ?? 200;
    const ok = r.ok ?? (status >= 200 && status < 300);
    const headerMap = new Map(
      Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      ok,
      status,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      text: async () => r.body ?? '',
    };
  };
  return { fetch, calls };
}
