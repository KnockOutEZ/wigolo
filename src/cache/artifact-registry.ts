/**
 * The artifact-provider registry — how a surface core does NOT own contributes rows to the SHARED
 * knowledge store's three read paths (`cache`, `find_similar`, `research`).
 *
 * WHY: those three paths used to import one specific product's capture module directly and emit that
 * product's name as a literal `source` / `engines` value. The discriminator in a shared store was a
 * product name, so a second product could not register — it would have had to edit core's query paths,
 * core's response types and core's research-type allowlist. Core now knows only "a provider owns some
 * keys and answers with its own id".
 *
 * The URI SCHEME is deliberately the provider's business, not core's: keys are already persisted in
 * the shared vector store and `index_jobs`, so core matching on a prefix it hardcodes would be the
 * same bug one layer down. Core asks `owns(key)`; the provider recognises its own scheme.
 *
 * Modelled on `src/plugins/registry.ts`: name-keyed dedup that warns rather than throws, a `clear()`
 * for tests, and every provider call wrapped — one provider's broken index must never abort a query
 * that other providers can still answer.
 */
import { createLogger } from '../logger.js';

const log = createLogger('cache');

/** One artifact resolved for retrieval. Provider-agnostic: no product-shaped fields. */
export interface ArtifactRecord {
  /** The stable, re-resolvable identity — also the shared vector-store / FTS key. */
  key: string;
  /** Provider-defined artifact type. Core never enumerates these. */
  type: string;
  title: string | null;
  markdown: string | null;
  /** Safe AS INSTRUCTIONS. Page-derived content is false even once a human curates it. */
  trusted: boolean;
  fetchedAt: string;
}

/**
 * A non-core surface that stores retrievable artifacts alongside `url_cache`.
 *
 * Intentionally as thin and structural as `Extractor` and `SearchEngine` in `types.ts`: an id, a
 * key predicate, a search, a hydrate, and an optional policy hook.
 */
export interface ArtifactProvider {
  /**
   * Provider id. This is the value an AGENT reads as `source` / `engines`, so it should describe the
   * surface rather than restate an implementation detail.
   */
  readonly name: string;
  /** True when `key` addresses one of THIS provider's artifacts. The provider owns its URI scheme. */
  owns(key: string): boolean;
  /** Provider-side full-text search, returning keys in rank order. */
  searchKeys(query: string, limit: number): string[];
  /** Resolve a key to its record. A miss (stale/forged key) returns null rather than throwing. */
  hydrate(key: string): ArtifactRecord | null;
  /**
   * Whether a record may be used as a RESEARCH source. Provider policy: only the provider knows
   * which of its own types carry citable prose. Absent ⇒ everything is researchable.
   */
  isResearchable?(record: ArtifactRecord): boolean;
}

export interface ArtifactHit {
  /** The owning provider's id — what the caller surfaces as `source`. */
  provider: string;
  record: ArtifactRecord;
}

const providers: ArtifactProvider[] = [];

/**
 * Register a provider. Refuses a duplicate id with a warning and returns — never throws, and the
 * FIRST registration wins, so a later import cannot silently repoint an existing scheme at a
 * different store.
 */
export function registerArtifactProvider(provider: ArtifactProvider): void {
  if (providers.some((p) => p.name === provider.name)) {
    log.warn('duplicate artifact provider name, ignoring', { name: provider.name });
    return;
  }
  providers.push(provider);
  log.debug('registered artifact provider', { name: provider.name });
}

export function getArtifactProviders(): ArtifactProvider[] {
  return [...providers];
}

export function clearArtifactProviders(): void {
  providers.length = 0;
  bootstrap = null;
}

/**
 * Provider modules that ship in this repo, resolved LAZILY and exactly once.
 *
 * A module reference is all core keeps: not the scheme, not the `source` label, not the artifact
 * types, not the SQL. A product living outside this repo calls `registerArtifactProvider` itself and
 * never appears here.
 *
 * The laziness buys a smaller import graph for the GATEWAY only. It does NOT defer `better-sqlite3`
 * on stdio: `server.ts -> tools/session-target.ts -> studio/capture/artifacts.ts -> cache/db.ts` is a
 * pre-existing STATIC edge, so the native binding loads on that path regardless of what this module
 * does. Do not rely on this for stdio load timing.
 *
 * EACH ENTRY MUST BE A THUNK WRAPPING A **LITERAL** `import()` SPECIFIER — never a variable, and never
 * an array of path strings iterated into `import(path)`. `packaging/binary/bundle.mjs` runs esbuild
 * with `bundle: true, format: 'cjs'`, and esbuild cannot follow a non-literal specifier: it silently
 * emits the call verbatim instead of inlining the module, and does not warn. In the packaged binary
 * that resolved to a path that does not exist, so the bootstrap caught ENOENT, registered nothing, and
 * every captured artifact vanished from `cache`, `find_similar` and `research` with no error reaching
 * the agent. A literal specifier IS bundled under those same flags and still resolves from source, so
 * laziness is preserved. `tests/unit/cache/bundle-provider-inlining.test.ts` is the guard.
 */
const IN_TREE_PROVIDER_LOADERS: Array<() => Promise<unknown>> = [
  () => import('../companion/artifact-provider.js'),
];

let bootstrap: Promise<void> | null = null;

/**
 * Resolve the provider set, loading in-tree providers on first use. Every artifact read path awaits
 * this once, then uses the synchronous accessors above. A module that fails to load is logged and
 * skipped — an unavailable surface degrades to "no artifacts", never to a failed query.
 */
export async function ensureArtifactProviders(): Promise<ArtifactProvider[]> {
  bootstrap ??= (async () => {
    for (const [index, load] of IN_TREE_PROVIDER_LOADERS.entries()) {
      try {
        const mod = (await load()) as Record<string, unknown>;
        for (const value of Object.values(mod)) {
          if (isArtifactProvider(value)) registerArtifactProvider(value);
        }
      } catch (err) {
        // `loaderIndex` is the whole diagnostic for the silent-degradation mode: this warn is the
        // ONLY signal that an artifact surface vanished, and a provider that THROWS DURING MODULE
        // EVALUATION produces an error naming nothing. It is an index rather than the specifier
        // because putting the path back as a data string would defeat the bundling guard (which
        // asserts no bare specifier survives) and core's neutrality pin.
        log.warn('artifact provider module unavailable; continuing without it', {
          loaderIndex: index,
          loaderCount: IN_TREE_PROVIDER_LOADERS.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
  await bootstrap;
  return getArtifactProviders();
}

/** Duck-type a module export, mirroring `plugins/validate.ts` — a bad export is skipped, not thrown. */
function isArtifactProvider(value: unknown): value is ArtifactProvider {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ArtifactProvider>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.owns === 'function' &&
    typeof candidate.searchKeys === 'function' &&
    typeof candidate.hydrate === 'function'
  );
}

/** The provider owning `key`, or undefined when no provider claims it (i.e. it is a url_cache url). */
export function artifactProviderFor(key: string): ArtifactProvider | undefined {
  for (const p of providers) {
    try {
      if (p.owns(key)) return p;
    } catch (err) {
      log.warn('artifact provider owns() failed; skipping provider for this key', {
        provider: p.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return undefined;
}

/**
 * True when `key` belongs to some registered provider. Callers route on this BEFORE url hydration:
 * artifact keys are deliberately not URL-parseable, so reaching `new URL()` with one throws.
 */
export function isArtifactKey(key: string): boolean {
  return artifactProviderFor(key) !== undefined;
}

/** Resolve a key to its record plus the id of the provider that owns it. */
export function resolveArtifact(key: string): ArtifactHit | null {
  const provider = artifactProviderFor(key);
  if (!provider) return null;
  try {
    const record = provider.hydrate(key);
    return record ? { provider: provider.name, record } : null;
  } catch (err) {
    log.warn('artifact hydration failed', {
      provider: provider.name,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Ranked keys across every provider, in registration order. `limit` is a TOTAL — N registered
 * products must not silently N-times the result budget the caller asked for. A provider that throws
 * is skipped: the query still returns what the healthy providers found.
 */
export function searchArtifactKeys(query: string, limit: number): string[] {
  if (limit <= 0) return [];
  const out: string[] = [];
  for (const p of providers) {
    if (out.length >= limit) break;
    try {
      for (const key of p.searchKeys(query, limit - out.length)) {
        out.push(key);
        if (out.length >= limit) break;
      }
    } catch (err) {
      log.warn('artifact provider search failed; continuing with other providers', {
        provider: p.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * Whether `record` may be cited as a research source. Fail-CLOSED on an unanswerable policy: an
 * unknown provider or a predicate that throws excludes the record, because an unclassifiable
 * artifact reaching a research brief is the expensive direction.
 */
export function isResearchableArtifact(providerName: string, record: ArtifactRecord): boolean {
  const provider = providers.find((p) => p.name === providerName);
  if (!provider) return false;
  if (!provider.isResearchable) return true;
  try {
    return provider.isResearchable(record);
  } catch (err) {
    log.warn('artifact researchability policy failed; excluding record', {
      provider: providerName,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
