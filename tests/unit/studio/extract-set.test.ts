import { describe, it, expect } from 'vitest';
import { inferRows, extractSet, type MatchSubtree, type ExtractSetDeps, type ExtractSetInput } from '../../../src/studio/extract-set.js';

// CDP DOM.Node-shaped minimal fixtures: nodeType 1 = element, 3 = text.
const el = (name: string, children: MatchSubtree[]): MatchSubtree => ({ nodeType: 1, nodeName: name, children });
const txt = (v: string): MatchSubtree => ({ nodeType: 3, nodeName: '#text', nodeValue: v, children: [] });
const card = (title: string, price: string): MatchSubtree =>
  el('DIV', [el('H3', [txt(title)]), el('SPAN', [txt(price)])]);

describe('inferRows', () => {
  it('derives stable columns from a repeating card structure', () => {
    const { columns, rows } = inferRows([card('Pro', '$20'), card('Team', '$40'), card('Free', '$0')]);
    expect(columns.length).toBe(2);
    expect(rows).toHaveLength(3);
    expect(Object.values(rows[0])).toEqual(['Pro', '$20']);
  });

  it('degrades a non-repeating / single unique element to one text column (NEGATIVE: no bogus wide cluster)', () => {
    const { columns, rows } = inferRows([el('P', [txt('just one paragraph of text')])]);
    expect(columns).toEqual(['text']);
    expect(rows[0].text).toContain('just one paragraph');
  });

  it('degrades to text when matches share no majority sub-path (NEGATIVE)', () => {
    const { columns } = inferRows([el('DIV', [el('H1', [txt('a')])]), el('DIV', [el('SPAN', [txt('b')])])]);
    expect(columns).toEqual(['text']);
  });

  it('leaves a cell empty when a match lacks a column', () => {
    const full = card('Pro', '$20');
    const partial = el('DIV', [el('H3', [txt('NoPrice')])]);
    const { columns, rows } = inferRows([full, full, partial]);
    // the price column (2nd) is absent on the partial match → empty string, not an undefined crash
    expect(rows[2][columns[1]] ?? '').toBe('');
  });

  it('returns empty for zero matches', () => {
    expect(inferRows([])).toEqual({ columns: [], rows: [] });
  });
});

function deps(over: Partial<ExtractSetDeps> = {}): ExtractSetDeps {
  return {
    resolveCluster: async () => ({ subtrees: [card('Pro', '$20'), card('Team', '$40')], refs: ['r1', 'r2'] }),
    isCredentialPage: async () => false,
    followNextPage: async () => ({ followed: false }),
    persist: async (p) => ({ id: 1, inserted: true, contentHash: 'h', columns: p.columns, rows: p.rows }),
    caps: { maxPagesCeiling: 20, maxRowsCeiling: 1000, defaultPages: 5, defaultRows: 200 },
    ...over,
  };
}
const input: ExtractSetInput = { tab_id: 't1', mark_id: 'm1' };

describe('extractSet', () => {
  it('extracts rows + persists (positive)', async () => {
    const r = await extractSet(input, deps());
    expect(r.stage).toBeUndefined();
    expect(r.rows).toHaveLength(2);
    expect(r.columns!.length).toBe(2);
    expect(r.artifact_id).toBe(1);
  });

  it('refuses on a credential page — nothing persisted (NEGATIVE)', async () => {
    let persisted = false;
    const r = await extractSet(input, deps({
      isCredentialPage: async () => true,
      persist: async (p) => { persisted = true; return { id: 1, inserted: true, contentHash: 'h', columns: p.columns, rows: p.rows }; },
    }));
    expect(r.stage).toBe('refused');
    expect(persisted).toBe(false);
  });

  it('no_such_mark when the cluster does not resolve (confused-deputy miss)', async () => {
    const r = await extractSet(input, deps({ resolveCluster: async () => ({ error: 'no_such_mark' }) }));
    expect(r.error_reason).toBe('no_such_mark');
  });

  it('clamps max_rows above the hard ceiling + sets truncated (NEGATIVE self-DoS)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => card(`n${i}`, `$${i}`));
    const r = await extractSet({ ...input, max_rows: 999999 }, deps({
      resolveCluster: async () => ({ subtrees: many, refs: many.map((_, i) => `r${i}`) }),
      caps: { maxPagesCeiling: 20, maxRowsCeiling: 10, defaultPages: 5, defaultRows: 200 },
    }));
    expect(r.rows!.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('follows pagination within max_pages then stops (positive)', async () => {
    let page = 0;
    const r = await extractSet({ ...input, follow_pagination: true, max_pages: 2 }, deps({
      resolveCluster: async () => ({ subtrees: [card(`p${page}`, '$1')], refs: [`r${page}`] }),
      followNextPage: async () => { page += 1; return { followed: page < 2 }; },
    }));
    expect(r.pages_followed).toBe(1); // 1 hop beyond the first page (2 pages total)
    expect(r.rows!.length).toBe(2);
  });

  it('terminates the follow when a hop lands on a credential page — that page not extracted (NEGATIVE)', async () => {
    let page = 0;
    const r = await extractSet({ ...input, follow_pagination: true, max_pages: 5 }, deps({
      resolveCluster: async () => ({ subtrees: [card(`p${page}`, '$1')], refs: [`r${page}`] }),
      isCredentialPage: async () => page >= 1, // page 1 is a login wall
      followNextPage: async () => { page += 1; return { followed: true }; },
    }));
    expect(r.rows!.length).toBe(1); // only page 0 rows
  });

  it('returns pending_approval when a pagination hop needs an ungranted grant (NEGATIVE SSRF)', async () => {
    const r = await extractSet({ ...input, follow_pagination: true }, deps({
      followNextPage: async () => ({ followed: false, pendingApproval: 'appr-1' }),
    }));
    expect(r.stage).toBe('pending_approval');
    expect(r.id).toBe('appr-1');
  });

  it('does NOT follow a blocked (cloud-metadata / internal) next-target — stops, no extra rows (NEGATIVE SSRF)', async () => {
    let page = 0;
    const r = await extractSet({ ...input, follow_pagination: true, max_pages: 5 }, deps({
      resolveCluster: async () => ({ subtrees: [card(`p${page}`, '$1')], refs: [`r${page}`] }),
      followNextPage: async () => { page += 1; return { followed: false }; }, // gated choke blocked the hop
    }));
    expect(r.rows!.length).toBe(1); // only the first page
    expect(r.pages_followed).toBe(0);
  });

  it('reports the real excluded count once (not per page) + exclude_refs shrinks the row set', async () => {
    const r = await extractSet({ ...input, exclude_refs: ['r2'] }, deps({
      resolveCluster: async () => ({ subtrees: [card('A', '$1'), card('B', '$2')], refs: ['r0', 'r1'], excludedCount: 1 }),
    }));
    expect(r.excluded).toBe(1);
    expect(r.rows).toHaveLength(2); // the excluded ref was already dropped by resolveCluster
  });
});
