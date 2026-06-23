import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P6-d LOCKED-B (structural invariant): the BROWSER-CREDENTIAL store — `src/studio/profile-store.ts`
 * (the encrypted website-login storageState store; sole-writer `src/studio/login-capture.ts`) — MUST
 * be UNREACHABLE from the `wigolo serve` dispatch. This is a security module-boundary invariant, so it
 * is asserted on the static IMPORT GRAPH (not a behavioral request spy): the serve dispatch entries
 * and their full transitive relative-import closure contain NO edge to the browser-credential store.
 *
 * (Distinct from the existing provider-key spy in http-server.test.ts, which pins a different,
 * acceptable refactor-safety property — a serve-dispatched LLM tool legitimately resolves a PROVIDER
 * key. LOCKED-B is the browser-credential store only.)
 */

const SRC = resolve(fileURLToPath(new URL('../../../src', import.meta.url)));

/** Resolve a relative import spec (`.js`→`.ts` source, `/index.ts`); non-relative (node_modules) → null. */
function resolveRelativeImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      readFileSync(cand);
      return cand;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Transitive closure of relative imports reachable from `entries`. */
function importClosure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
      const resolved = resolveRelativeImport(file, m[1]);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

describe('P6-d LOCKED-B — browser-credential store unreachable from the serve dispatch', () => {
  it('the serve dispatch import closure contains NO edge to the browser-credential store', () => {
    // The `wigolo serve` dispatch entries: the HTTP server (routes/handlers) + the MCP tool dispatch.
    const closure = importClosure([join(SRC, 'daemon/http-server.ts'), join(SRC, 'server.ts')]);

    // sanity: the closure actually walked the serve dispatch (not an empty/parse-fail set).
    expect(closure.has(join(SRC, 'daemon/http-server.ts'))).toBe(true);
    expect(closure.size).toBeGreaterThan(20);

    // LOCKED-B: the browser-credential store + its sole-writer are NOT in the closure.
    // mutation: add `import { ProfileStore } from '../studio/profile-store.js'` (+ a read) to
    // http-server.ts → profile-store.ts enters the closure → these REDS.
    expect(closure.has(join(SRC, 'studio/profile-store.ts'))).toBe(false);
    expect(closure.has(join(SRC, 'studio/login-capture.ts'))).toBe(false);
  });
});
