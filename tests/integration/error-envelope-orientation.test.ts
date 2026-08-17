import { describe, it, expect, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer, type Subsystems } from '../../src/server.js';
import { dispatchTool, type DispatchContext } from '../../src/daemon/rest/dispatch.js';
import type { RawFetchResult, StageError } from '../../src/types.js';
import { ChallengeBlockedError } from '../../src/fetch/browser-pool.js';

/**
 * WHICH FIELD CARRIES THE MACHINE CODE.
 *
 * docs/rest-api.md ("Error shape") publishes `error_reason` as the stable code a client keys on and
 * `error` as the human message. The producer side is the other way round — a StageResult carries the
 * code in `error` and prose in `error_reason` — so both envelope assemblies have to re-orient on the
 * way out. They used to copy the fields straight across, which published a whole sentence as the
 * machine code: anyone writing `if (err.error_reason === 'blocked_by_challenge')` against the
 * documented contract was wrong through no fault of their own, and the D10 tool audit recorded prose
 * where it expected a typed reason.
 *
 * BOTH DIRECTIONS ARE ASSERTED on every case. Pinning only "the code is in error_reason" is satisfied
 * by an envelope that duplicates the code into both fields and throws the message away.
 *
 * The producer shape is NEVER a hand-written literal: it is a real `handleFetch` / `handleDiff`
 * return, driven by a stub router or a forced throw. A literal shaped to satisfy the assembly is
 * exactly what let the original orientation bug live.
 */

vi.mock('../../src/watch/scheduler.js', () => ({ scheduleOverdueCheck: vi.fn() }));
vi.mock('../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(() => undefined),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn(() => ({ usable: false, stale: false })),
  normalizeUrl: vi.fn((u: string) => u),
}));
vi.mock('../../src/cache/change-detector.js', () => ({ detectChange: vi.fn(() => ({ changed: false })) }));

/** The exact shape the browser tier's own error class produces — code and prose both read off it. */
const raised = new ChallengeBlockedError('https://blocked.example/x');
const BLOCK: StageError = {
  error: raised.code,
  error_reason: raised.message,
  stage: 'fetch',
  http_status: 403,
};

function routerReturning(result: RawFetchResult | StageError): never {
  return { fetch: vi.fn(async () => result), getDomainStats: vi.fn() } as never;
}

function stubSubsystems(router: unknown): Subsystems {
  return {
    searchEngines: [],
    router,
    backendStatus: {},
    browserPool: {},
    pluginRegistry: {},
    shutdown: async () => {},
    bootstrapSearxng: async () => {},
  } as unknown as Subsystems;
}

async function callMcpTool(
  subsystems: Subsystems,
  name: string,
  args: Record<string, unknown>,
): Promise<{ error: string; error_reason: string; stage: string }> {
  const server = createMcpServer(subsystems);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  const blocks = res.content as Array<{ type: string; text: string }>;
  return JSON.parse(blocks[0].text) as { error: string; error_reason: string; stage: string };
}

function restCtx(router: unknown): DispatchContext {
  return { subsystems: stubSubsystems(router), bindIsLoopback: true, untrustedMode: 'envelope' };
}

describe('published error envelope — code in error_reason, message in error', () => {
  it('MCP: a real upstream block publishes the code as error_reason and the prose as error', async () => {
    const env = await callMcpTool(stubSubsystems(routerReturning(BLOCK)), 'fetch', {
      url: 'https://blocked.example/x',
    });

    expect(env.error_reason).toBe('blocked_by_challenge');
    // `toContain`, not `toBe`: the prose field is wrapped in the untrusted-data region at the assembly
    // seam (it is the field producers splice origin bytes into). The CODE is still asserted
    // byte-exactly above — that is the orientation this file guards, and the fence must never widen to
    // it. See tests/integration/error-envelope-fence.test.ts.
    expect(env.error).toContain(raised.message);
    // The two must not collapse into each other — a duplicating envelope loses the message.
    expect(env.error).not.toBe(env.error_reason);
    expect(env.stage).toBe('fetch');
  });

  it('REST: the same producer return publishes the same orientation through the serve seam', async () => {
    const r = await dispatchTool('fetch', { url: 'https://blocked.example/x' }, restCtx(routerReturning(BLOCK)));
    const body = r.body as { ok: boolean; error: string; error_reason: string; stage: string };

    expect(body.ok).toBe(false);
    expect(body.error_reason).toBe('blocked_by_challenge');
    expect(body.error).toContain(raised.message); // fenced prose — see the MCP case above
    expect(body.error).not.toBe(body.error_reason);
    // The status table keys on the PRODUCER's field, so it is unaffected by the re-orientation.
    expect(r.status).toBe(502);
  });

  it('MCP: a pre-network guard refusal keeps the same orientation — not just the fetch-failure arm', async () => {
    // handleFetch's own SSRF gate produces this; the router is never reached.
    const env = await callMcpTool(stubSubsystems(routerReturning(BLOCK)), 'fetch', {
      url: 'http://169.254.169.254/latest/meta-data',
    });

    expect(env.error_reason).toBe('invalid_url');
    expect(env.error).not.toBe('invalid_url');
    expect(env.error.length).toBeGreaterThan(0);
  });
});
