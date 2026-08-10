/**
 * The guard for slice-P1c item 1: core's three SHARED-STORE read paths must not name a product.
 *
 * This is deliberately NOT a repo-wide "no 'studio' string in src/" sweep. Such a sweep cannot tell a
 * contract leak from the legitimate cases — `src/cli/index.ts`'s subcommand (a CLI command named after
 * the product is correct), the shared-infrastructure comments in `src/security/ssrf.ts`, or the false
 * positives `com.visualstudio.code` / "LM Studio" / "Google AI Studio". A guard that cannot distinguish
 * those is worse than none, so this one names the four files whose CONTRACTS were leaking and asserts
 * the negative cases explicitly.
 *
 * The behavioural half matters more than the textual half: the last two tests drive `handleCache` with a
 * provider core has never heard of and assert its rows surface under ITS id. Those red if anyone
 * re-hardcodes a product name on the path, whatever the strings happen to say.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VectorSearchResult } from '../../../src/providers/vector-store.js';

const vecState: { size: number; results: VectorSearchResult[] } = { size: 0, results: [] };

vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({
    modelId: 'test', dim: 4, embed: vi.fn(async () => [new Float32Array([1, 0, 0, 0])]),
  })),
}));
vi.mock('../../../src/providers/vector-store.js', () => ({
  getVectorStore: vi.fn(async () => ({
    upsert: vi.fn(), delete: vi.fn(),
    size: vi.fn(async () => vecState.size),
    search: vi.fn(async () => vecState.results),
  })),
}));

import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { handleCache } from '../../../src/tools/cache.js';
import {
  registerArtifactProvider,
  clearArtifactProviders,
  type ArtifactProvider,
} from '../../../src/cache/artifact-registry.js';

const ROOT = join(import.meta.dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** The shared-store read paths. None of these may name a product. */
const NEUTRAL_CORE_PATHS = [
  'src/tools/cache.ts',
  'src/search/find-similar.ts',
  'src/research/pipeline.ts',
];

describe('core shared-store read paths name no product', () => {
  it.each(NEUTRAL_CORE_PATHS)('%s contains no product name and no product URI scheme', (rel) => {
    const src = read(rel);
    // Case-insensitive on purpose: `source: 'studio'`, `studioFtsRankMap`, `STUDIO_RESEARCH_TYPES`
    // and `../studio/capture/artifacts.js` were all leaks, and they differ only in case.
    const hits = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /studio/i.test(line));
    expect(hits, `product name still present in ${rel}`).toEqual([]);
  });

  it.each(NEUTRAL_CORE_PATHS)('%s imports nothing from the studio module', (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/from ['"][^'"]*\/studio\//);
  });

  it('the registry keeps a module reference and nothing else — no scheme, no label, no artifact types', () => {
    const src = read('src/cache/artifact-registry.ts');
    // Assert on CODE, not prose. Comments in this file legitimately explain the bundling constraint
    // and the pre-existing stdio import edge, and both must name the module to be useful; policing
    // them would only push accurate documentation out of the file.
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return t !== '' && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      });
    const hits = code.filter((l) => /studio/i.test(l));
    // Exactly one executable reference: the lazy in-tree bootstrap loader. If a scheme, a `source`
    // value or a type allowlist ever creeps back into the code, this count moves.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("import('../studio/artifact-provider.js')");
    // The persisted URI prefix is the provider's business — core must never match on it, in code or
    // in a comment that someone might later turn into code.
    expect(src).not.toContain('studio://');
  });

  it('core response types no longer close the source union around a product name', () => {
    const types = read('src/types.ts');
    // A closed union here was the contract leak: a second surface could not appear in a result
    // without core being edited.
    expect(types).not.toMatch(/source:\s*'cache'\s*\|\s*'studio'/);
    expect(types).not.toMatch(/source:\s*'cache'\s*\|\s*'search'\s*\|\s*'studio'/);
  });

  // ── The negative half: this guard must be SCOPED, not a blanket sweep ────────────────────────
  it('does NOT police the legitimate cases — a CLI subcommand and shared infrastructure keep the name', () => {
    // A CLI subcommand named after the product is correct, and ssrf.ts is genuinely shared
    // infrastructure whose comments reference the caller. Both still say "studio"; neither is in
    // NEUTRAL_CORE_PATHS. If someone widens this guard to all of src/, these two red first.
    expect(read('src/cli/index.ts')).toMatch(/studio/i);
    expect(read('src/security/ssrf.ts')).toMatch(/studio/i);
    for (const rel of ['src/cli/index.ts', 'src/security/ssrf.ts']) {
      expect(NEUTRAL_CORE_PATHS).not.toContain(rel);
    }
  });

  it('does NOT fire on the known false positives, which a naive /studio/i sweep would flag', () => {
    // `com.visualstudio.code` and "LM Studio" / "Google AI Studio" all match /studio/i and are all
    // unrelated to this product. Proof that the case-insensitive rule above is only safe BECAUSE it
    // is scoped to three files.
    expect(read('src/cli/agents/vscode.ts')).toMatch(/visualstudio/i);
    for (const rel of ['src/cli/agents/vscode.ts', 'src/integrations/cloud/llm/select.ts']) {
      expect(NEUTRAL_CORE_PATHS).not.toContain(rel);
    }
  });
});

/**
 * A provider core has never heard of. Not named 'studio', not using `studio://`, and it hydrates from
 * memory so nothing about the studio storage layer is involved.
 */
function atlasProvider(): ArtifactProvider {
  const rows: Record<string, { title: string; markdown: string }> = {
    'atlas://page|1': { title: 'Atlas Ledger', markdown: 'quarterly reconciliation ledger for atlas' },
  };
  return {
    name: 'atlas',
    owns: (key) => key.startsWith('atlas://'),
    searchKeys: (_q, limit) => Object.keys(rows).slice(0, limit),
    hydrate: (key) => {
      const row = rows[key];
      return row
        ? { key, type: 'ledger', title: row.title, markdown: row.markdown, trusted: false, fetchedAt: '2026-08-04T00:00:00Z' }
        : null;
    },
  };
}

describe('a second product surfaces through the cache tool under its OWN id', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    clearArtifactProviders();
    vecState.size = 0;
    vecState.results = [];
  });
  afterEach(() => {
    clearArtifactProviders();
    closeDatabase();
  });

  it('FTS mode: an unknown provider\'s row surfaces with source = the provider id', async () => {
    registerArtifactProvider(atlasProvider());

    const out = await handleCache({ query: 'atlas reconciliation ledger', limit: 5 });
    const hit = (out.results ?? []).find((r) => r.url === 'atlas://page|1');

    expect(hit, 'an unregistered-in-core provider must still surface').toBeDefined();
    // THE assertion. Before this slice the cache tool hardcoded `source: 'studio'`, so this row
    // would have been mislabelled as the other product — the BrowserOS failure mode exactly.
    expect(hit!.source).toBe('atlas');
    expect(hit!.title).toBe('Atlas Ledger');
    expect(hit!.trusted).toBe(false);
  });

  it('hybrid mode: the same row fuses via the shared vector store under its own id', async () => {
    registerArtifactProvider(atlasProvider());
    vecState.size = 1;
    vecState.results = [
      { id: 'atlas://page|1', score: 0.9, metadata: { url: 'atlas://page|1', contentHash: 'h', modelId: 'test' } },
    ];

    const out = await handleCache({ query: 'atlas reconciliation ledger', mode: 'hybrid', limit: 5 });
    const hit = (out.results ?? []).find((r) => r.url === 'atlas://page|1');

    expect(hit, 'the hybrid key-shape routing must reach the owning provider').toBeDefined();
    expect(hit!.source).toBe('atlas');
    // Routed to the provider, NOT through url_cache — an artifact key is not URL-parseable, so a
    // url_cache lookup would have thrown or silently dropped it.
    expect(hit!.markdown).toContain('reconciliation');
  });
});
