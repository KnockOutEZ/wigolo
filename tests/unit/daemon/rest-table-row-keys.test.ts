import { describe, it, expect, vi } from 'vitest';
import { dispatchTool, type DispatchContext } from '../../../src/daemon/rest/dispatch.js';
import type { UntrustedMode } from '../../../src/daemon/rest/untrusted-mode.js';
import { UNTRUSTED_BEGIN_PREFIX } from '../../../src/security/untrusted.js';

/**
 * F7 at the REST BOUNDARY.
 *
 * My migration analysis for the row-key fix claimed "REST clients see the unchanged producer shape",
 * reasoning from `dispatchExtract`'s inner return being unfenced. That was FALSE, and this file exists
 * because of it: `dispatchTool` shapes every 200 through `shapeUntrusted`, whose default (`inline`,
 * the fallback passed at both router call sites) routes to `fenceRestBody` -> `fenceExtractData`. The
 * docstring on `fenceRestBody` states the intent outright — REST and MCP get byte-identical
 * containment modulo the nonce, so there is no second fence implementation to drift.
 *
 * So the `col_N` row keys DO land on REST. That is correct — the channel must close at every fenced
 * seam — but it is a real wire-shape change for REST/SDK callers, and it was untested: the integration
 * test for this fix replicates server.ts's two lines rather than driving this seam. Pinning it here
 * means a future change to the REST shaping cannot silently reopen the key channel or silently revert
 * the shape on one surface but not the other.
 */

const TH = 'TH_CANARY_r3st';
const TABLES = [{ caption: 'Plans', headers: [TH, 'Price'], rows: [{ [TH]: 'Pro', Price: '$20' }] }];

vi.mock('../../../src/tools/extract.js', () => ({
  handleExtract: vi.fn(async () => ({ ok: true, data: { mode: 'tables', data: TABLES, source_url: 'https://x.example/p' } })),
}));
vi.mock('../../../src/watch/scheduler.js', () => ({ scheduleOverdueCheck: vi.fn() }));

function ctxWith(mode: UntrustedMode): DispatchContext {
  return { subsystems: { router: {} } as never, bindIsLoopback: true, untrustedMode: mode };
}

type Body = { data: Array<{ headers: string[]; rows: Array<Record<string, string>> }> };

describe('F7 REST boundary — extract table row keys', () => {
  it('the DEFAULT (inline) REST representation ships col_N keys, never the <th> text', async () => {
    // MUT: revert fenceRow → the <th> returns as a bare JSON key on the REST surface too → RED.
    const res = await dispatchTool('extract', { url: 'https://x.example/p', mode: 'tables' }, ctxWith('inline'));

    expect(res.status).toBe(200);
    const body = res.body as Body;
    expect(Object.keys(body.data[0].rows[0])).toEqual(['col_1', 'col_2']);
    expect(JSON.stringify(body)).not.toContain(`"${TH}"`);
    // The label survives exactly once, fenced, reachable by index — same contract as the MCP envelope.
    expect(body.data[0].headers[0]).toContain(UNTRUSTED_BEGIN_PREFIX);
    expect(JSON.stringify(body).split(TH).length - 1).toBe(1);
    expect(body.data[0].rows[0].col_1).toContain('Pro');
    expect(body.data[0].rows[0].col_2).toContain('$20');
  });

  it('REST inline and the MCP envelope agree on the shape — one fence implementation, not two', async () => {
    // The property fenceRestBody's docstring claims. MUT: give REST its own row-shaping → the key sets
    // diverge → RED. This is what stops one surface being fixed while the other silently is not.
    const { fenceExtractData } = await import('../../../src/server/content-fence.js');
    const rest = (await dispatchTool('extract', { url: 'https://x.example/p', mode: 'tables' }, ctxWith('inline'))).body as Body;
    const mcp = fenceExtractData({ mode: 'tables', data: TABLES, source_url: 'https://x.example/p' } as never) as unknown as Body;

    expect(Object.keys(rest.data[0].rows[0])).toEqual(Object.keys(mcp.data[0].rows[0]));
  });

  it('the `envelope` opt-in stays byte-clean — page prose remains the key, BY CONTRACT not by oversight', async () => {
    // A10/A11: `envelope` is the explicit opt-in to an unmodified payload plus sibling `untrusted_content`
    // metadata, for programmatic consumers who need the bytes intact. withUntrustedEnvelope only spreads
    // the body, so it neither fences values nor rewrites keys — exactly as `markdown` is left raw there.
    // Pinned so the difference reads as the documented trade-off it is, and so a future change to that
    // opt-in has to face this test rather than slide past it.
    const res = await dispatchTool('extract', { url: 'https://x.example/p', mode: 'tables' }, ctxWith('envelope'));

    const body = res.body as Body & { untrusted_content?: unknown };
    expect(body.untrusted_content).toBeDefined();
    expect(Object.keys(body.data[0].rows[0])).toEqual([TH, 'Price']);
    expect(body.data[0].headers[0]).toBe(TH);
  });
});
