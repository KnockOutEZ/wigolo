/**
 * The artifact-provider registry — the seam that stops core from naming a product inside the SHARED
 * knowledge store.
 *
 * WHY this exists rather than the three hardcoded studio call paths it replaces: `src/tools/cache.ts`,
 * `src/search/find-similar.ts` and `src/research/pipeline.ts` each imported `isStudioEmbedKey` /
 * `searchStudioArtifactKeys` / `getStudioArtifactByEmbedKey` and each emitted a literal
 * `source: 'studio'` / `engines: ['studio']`. The discriminator in a shared store was a PRODUCT NAME,
 * so a second product could not register at all — it would have had to edit core's three query paths
 * and core's response types. That is the failure mode where a second product's output lands in the
 * first product's namespace.
 *
 * The tests below therefore assert the property that matters: a provider core has never heard of can
 * register, its keys route to IT and not to url_cache, and the `source` an agent reads is the
 * PROVIDER'S OWN id. Any test here that would still pass with `'studio'` hardcoded is not doing its
 * job.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  registerArtifactProvider,
  getArtifactProviders,
  clearArtifactProviders,
  resolveArtifact,
  isArtifactKey,
  searchArtifactKeys,
  artifactProviderFor,
  isResearchableArtifact,
  ensureArtifactProviders,
  type ArtifactProvider,
  type ArtifactRecord,
} from '../../../src/cache/artifact-registry.js';

function record(key: string, over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    key,
    type: 'clip',
    title: 'T',
    markdown: 'body',
    trusted: false,
    fetchedAt: '2026-08-04T00:00:00Z',
    ...over,
  };
}

/** A provider core has NEVER heard of — deliberately not named 'studio' and not using `studio://`. */
function fakeProvider(name: string, scheme: string, rows: Record<string, ArtifactRecord>): ArtifactProvider {
  return {
    name,
    owns: (key) => key.startsWith(scheme),
    searchKeys: (_q, limit) => Object.keys(rows).slice(0, limit),
    hydrate: (key) => rows[key] ?? null,
  };
}

describe('artifact-provider registry', () => {
  beforeEach(() => clearArtifactProviders());
  afterEach(() => {
    clearArtifactProviders();
    vi.restoreAllMocks();
  });

  // ── The property the whole slice exists for ────────────────────────────────────────────────────
  it('a provider core has never heard of registers, and the agent-visible source is the PROVIDER id', () => {
    const rows = { 'atlas://page|7': record('atlas://page|7', { title: 'Atlas page' }) };
    registerArtifactProvider(fakeProvider('atlas', 'atlas://', rows));

    const hit = resolveArtifact('atlas://page|7');
    // If core hardcoded 'studio' anywhere on this path, `provider` could not read 'atlas'.
    expect(hit?.provider).toBe('atlas');
    expect(hit?.record.title).toBe('Atlas page');
  });

  it('TWO products co-exist: each key routes to its OWN provider, never to the other', () => {
    registerArtifactProvider(fakeProvider('atlas', 'atlas://', { 'atlas://a|1': record('atlas://a|1', { title: 'A' }) }));
    registerArtifactProvider(fakeProvider('borealis', 'borealis://', { 'borealis://b|1': record('borealis://b|1', { title: 'B' }) }));

    expect(resolveArtifact('atlas://a|1')?.provider).toBe('atlas');
    expect(resolveArtifact('borealis://b|1')?.provider).toBe('borealis');
    // The cross pairing must MISS, not silently resolve against the wrong store.
    expect(resolveArtifact('atlas://b|1')).toBeNull();
  });

  it('a plain http url is NOT an artifact key — url_cache keeps its own hydration path', () => {
    registerArtifactProvider(fakeProvider('atlas', 'atlas://', {}));
    expect(isArtifactKey('https://example.com/a')).toBe(false);
    expect(isArtifactKey('atlas://a|1')).toBe(true);
    // With no provider registered at all, nothing is an artifact key — core must not
    // accidentally claim url_cache rows.
    clearArtifactProviders();
    expect(isArtifactKey('atlas://a|1')).toBe(false);
  });

  // ── Resilience: one bad provider must never take out the query path ───────────────────────────
  it('a provider whose searchKeys THROWS is skipped; the other provider still contributes', () => {
    const boom: ArtifactProvider = {
      name: 'boom',
      owns: (k) => k.startsWith('boom://'),
      searchKeys: () => { throw new Error('index corrupt'); },
      hydrate: () => null,
    };
    registerArtifactProvider(boom);
    registerArtifactProvider(fakeProvider('atlas', 'atlas://', { 'atlas://a|1': record('atlas://a|1') }));

    // The whole point: a studio-read failure never aborted research before, and a THIRD-PARTY
    // provider failure must not either.
    expect(searchArtifactKeys('q', 10)).toEqual(['atlas://a|1']);
  });

  it('a provider whose hydrate THROWS yields a clean null, never a thrown query', () => {
    registerArtifactProvider({
      name: 'boom',
      owns: (k) => k.startsWith('boom://'),
      searchKeys: () => ['boom://x|1'],
      hydrate: () => { throw new Error('db gone'); },
    });
    expect(() => resolveArtifact('boom://x|1')).not.toThrow();
    expect(resolveArtifact('boom://x|1')).toBeNull();
  });

  it('a provider whose OWNS throws does not poison key routing for the others', () => {
    registerArtifactProvider({
      name: 'boom',
      owns: () => { throw new Error('nope'); },
      searchKeys: () => [],
      hydrate: () => null,
    });
    registerArtifactProvider(fakeProvider('atlas', 'atlas://', { 'atlas://a|1': record('atlas://a|1') }));
    expect(resolveArtifact('atlas://a|1')?.provider).toBe('atlas');
    expect(isArtifactKey('atlas://a|1')).toBe(true);
  });

  // ── Registration semantics, mirroring src/plugins/registry.ts ─────────────────────────────────
  it('a duplicate provider id is refused with a warning, never thrown, and never double-registered', () => {
    registerArtifactProvider(fakeProvider('atlas', 'atlas://', {}));
    expect(() => registerArtifactProvider(fakeProvider('atlas', 'other://', {}))).not.toThrow();
    expect(getArtifactProviders()).toHaveLength(1);
    // The FIRST registration wins — a later import must not silently repoint an existing scheme.
    expect(getArtifactProviders()[0].owns('other://x')).toBe(false);
  });

  it('searchKeys fans out in registration order and honours the total limit', () => {
    registerArtifactProvider(fakeProvider('atlas', 'atlas://', {
      'atlas://a|1': record('atlas://a|1'), 'atlas://a|2': record('atlas://a|2'),
    }));
    registerArtifactProvider(fakeProvider('borealis', 'borealis://', {
      'borealis://b|1': record('borealis://b|1'),
    }));
    expect(searchArtifactKeys('q', 3)).toEqual(['atlas://a|1', 'atlas://a|2', 'borealis://b|1']);
    // The limit is a TOTAL, not per-provider — otherwise N products silently N-times the budget
    // an agent asked for.
    expect(searchArtifactKeys('q', 2)).toEqual(['atlas://a|1', 'atlas://a|2']);
    expect(searchArtifactKeys('q', 0)).toEqual([]);
  });

  it('artifactProviderFor resolves the owner without hydrating', () => {
    let hydrated = 0;
    registerArtifactProvider({
      name: 'atlas',
      owns: (k) => k.startsWith('atlas://'),
      searchKeys: () => [],
      hydrate: () => { hydrated++; return null; },
    });
    expect(artifactProviderFor('atlas://a|1')?.name).toBe('atlas');
    expect(hydrated).toBe(0);
    expect(artifactProviderFor('https://example.com')).toBeUndefined();
  });

  // ── Research eligibility is PROVIDER POLICY, not a core-side type allowlist ────────────────────
  it('the provider decides which of its own artifact types are researchable', () => {
    registerArtifactProvider({
      name: 'atlas',
      owns: (k) => k.startsWith('atlas://'),
      searchKeys: () => [],
      hydrate: () => null,
      isResearchable: (r) => r.type !== 'mark',
    });
    expect(isResearchableArtifact('atlas', record('atlas://a|1', { type: 'clip' }))).toBe(true);
    // Core must NOT keep its own hardcoded {clip,qa,note} set — that set was a studio-shaped
    // literal in research/pipeline.ts and a second product's types would have been silently dropped.
    expect(isResearchableArtifact('atlas', record('atlas://a|1', { type: 'mark' }))).toBe(false);
    expect(isResearchableArtifact('atlas', record('atlas://a|1', { type: 'ledger-entry' }))).toBe(true);
  });

  it('a provider with NO isResearchable predicate is treated as fully researchable (fail-open)', () => {
    registerArtifactProvider(fakeProvider('atlas', 'atlas://', {}));
    expect(isResearchableArtifact('atlas', record('atlas://a|1', { type: 'anything' }))).toBe(true);
  });

  it('an isResearchable predicate that throws excludes the record (fail-CLOSED on policy)', () => {
    registerArtifactProvider({
      name: 'atlas',
      owns: (k) => k.startsWith('atlas://'),
      searchKeys: () => [],
      hydrate: () => null,
      isResearchable: () => { throw new Error('policy blew up'); },
    });
    // A policy predicate that cannot answer must not be read as "yes" — an unclassifiable
    // artifact reaching a research brief is the expensive direction.
    expect(isResearchableArtifact('atlas', record('atlas://a|1'))).toBe(false);
  });

  it('an unknown provider id is not researchable', () => {
    expect(isResearchableArtifact('never-registered', record('x://1'))).toBe(false);
  });
});

describe('in-tree provider bootstrap', () => {
  beforeEach(() => clearArtifactProviders());
  afterEach(() => clearArtifactProviders());

  it('resolves the in-tree capture provider lazily, so core keeps a module path and nothing else', async () => {
    // Before the bootstrap runs, core knows about NO artifact keys at all — proof the three read
    // paths get their studio behaviour from the registry rather than a static import.
    expect(isArtifactKey('studio://clip|1')).toBe(false);

    const resolved = await ensureArtifactProviders();

    expect(resolved.length).toBeGreaterThan(0);
    // The provider recognises its OWN persisted scheme. Core must never carry that prefix; this
    // asserts it still routes once the provider is loaded.
    expect(isArtifactKey('studio://clip|1')).toBe(true);
    expect(artifactProviderFor('studio://clip|1')?.name).toBe('studio');
    // A url_cache url stays core's business.
    expect(isArtifactKey('https://example.com/a')).toBe(false);
  });

  it('the bootstrap is idempotent — a second await does not double-register', async () => {
    const first = await ensureArtifactProviders();
    const second = await ensureArtifactProviders();
    expect(second).toHaveLength(first.length);
    const names = second.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('an already-registered provider is preserved across the bootstrap', async () => {
    registerArtifactProvider(fakeProvider('atlas', 'atlas://', { 'atlas://a|1': record('atlas://a|1') }));
    await ensureArtifactProviders();
    expect(artifactProviderFor('atlas://a|1')?.name).toBe('atlas');
    expect(artifactProviderFor('studio://clip|1')?.name).toBe('studio');
  });
});
