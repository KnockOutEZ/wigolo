import { describe, it, expect } from 'vitest';
import { handleExtract } from '../../src/tools/extract.js';
import { fenceExtractData } from '../../src/server/content-fence.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import type { ExtractOutput } from '../../src/types.js';

/**
 * F7 at the TOOL BOUNDARY.
 *
 * The unit tests hand fenceExtractData a hand-built TableData. That cannot catch the case where the real
 * extractor produces a row shape the fence does not expect, so these drive the actual `extract` path — raw
 * HTML through handleExtract, then the exact fence + serialize that src/server.ts performs before the
 * result reaches the agent. A `<th>` canary must appear in the envelope ONLY inside a fence, never as a
 * JSON key, on both keyless modes that expose tables.
 *
 * `html` input needs no network and no router, which is why this is deterministic and offline.
 */
const router = null as unknown as SmartRouter;

const CANARY = 'TH_CANARY_7f3a91X';
const HTML = `<!doctype html><html><body><h1>Plans</h1>
<table>
  <caption>Pricing</caption>
  <thead><tr><th>${CANARY}</th><th>Price</th></tr></thead>
  <tbody>
    <tr><td>Pro</td><td>$20</td></tr>
    <tr><td>Free</td><td>$0</td></tr>
  </tbody>
</table></body></html>`;

/** Exactly what src/server.ts ships for `extract`: fence the handler's data, then JSON.stringify it. */
async function envelope(mode: 'tables' | 'structured'): Promise<{ json: string; out: ExtractOutput }> {
  const r = await handleExtract({ html: HTML, mode }, router);
  expect(r.ok, `extract mode:${mode} should succeed`).toBe(true);
  if (!r.ok) throw new Error('unreachable');
  const out = fenceExtractData(r.data);
  return { json: JSON.stringify(out, null, 2), out };
}

function tablesOf(out: ExtractOutput): Array<{ headers: string[]; rows: Array<Record<string, string>> }> {
  return (Array.isArray(out.data) ? out.data : (out.data as { tables?: unknown[] }).tables) as Array<{
    headers: string[];
    rows: Array<Record<string, string>>;
  }>;
}

describe.each(['tables', 'structured'] as const)('F7 integration — extract mode:"%s" row keys', (mode) => {
  it('never ships the <th> text as a bare JSON key', async () => {
    // MUT: revert fenceRow (or, for 'structured', the `k === 'tables'` routing) → the canary reappears as a
    // bare key once per row → RED. This is the defect exactly as reproduced against the built dist.
    const { json, out } = await envelope(mode);

    expect(json).not.toContain(`"${CANARY}"`);
    for (const t of tablesOf(out)) {
      for (const row of t.rows) {
        for (const k of Object.keys(row)) expect(k).toMatch(/^col_\d+$/);
      }
    }
  });

  it('keeps the header prose exactly once, inside a fence, still joinable to its cells by index', async () => {
    // The must-not-fire half: closing the channel must not cost the agent the ability to read the table.
    // MUT: stop fencing headers, or drop the cells → count != 1, or the cell lookup goes undefined → RED.
    const { json, out } = await envelope(mode);
    const table = tablesOf(out).find((t) => t.headers.some((h) => h.includes(CANARY)));

    expect(table, 'the canary table should be present').toBeDefined();
    expect(json.split(CANARY).length - 1).toBe(1);
    expect(table!.headers[0]).toContain('[[BEGIN UNTRUSTED DATA nonce=');
    expect(table!.rows).toHaveLength(2);
    expect(table!.rows[0].col_1).toContain('Pro');
    expect(table!.rows[0].col_2).toContain('$20');
    expect(table!.rows[1].col_1).toContain('Free');
  });
});
