import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The property names an interface in `src/types.ts` DECLARES, read out of the source at test time.
 *
 * This exists so the key vocabulary of a response object is never a snapshot. A snapshot answers
 * "are the keys the same as last time"; a field added to `SearchOutput` would pass, because the
 * fixture that would have emitted it does not exist yet, and nothing would ever ask for one. Reading
 * the DECLARATION lets the invariant ask the opposite question — "is every declared field actually
 * exercised" — which is what makes a newly-added field fail by default instead of waiting for a
 * reviewer.
 *
 * It is deliberately a SOURCE read, not a type-level construct. Types are erased at runtime, and the
 * whole premise of this guard is that a type name is not a validation: the check has to happen where
 * the bytes are.
 */

const TYPES_PATH = fileURLToPath(new URL('../../src/types.ts', import.meta.url));

/**
 * A numeric `const NAME = <int>;` read out of a `src/` file at test time.
 *
 * Used for `MAX_FENCE_DEPTH`, which is module-private in `src/server/content-fence.ts` and cannot be
 * imported. Copying the number into the test tree would make the walker's depth bound a constant that
 * silently stops relating to the fencer's the first time either moves — and the whole point of the
 * bound is the RELATION between the two, not either value.
 */
export function sourceConstant(relPath: string, name: string): number {
  const abs = fileURLToPath(new URL(`../../${relPath}`, import.meta.url));
  const m = new RegExp(`\\bconst ${name}\\s*=\\s*(\\d+)\\b`).exec(readFileSync(abs, 'utf8'));
  if (!m) throw new Error(`${relPath} declares no numeric const ${name}`);
  return Number(m[1]);
}

let source: string | undefined;
function typesSource(): string {
  source ??= readFileSync(TYPES_PATH, 'utf8');
  return source;
}

/** Strip block and line comments so a property name inside prose is never mistaken for a field. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Property names declared at the TOP level of `export interface <name>`. Nested inline object
 * literals are skipped by brace depth — their keys belong to the inline shape, not to this
 * interface, and they are covered by their own key-policy row.
 */
export function declaredFields(interfaceName: string): string[] {
  const src = typesSource();
  const start = src.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) throw new Error(`src/types.ts declares no interface ${interfaceName}`);
  let depth = 0;
  let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = stripComments(src.slice(src.indexOf('{', start) + 1, end));
  const fields: string[] = [];
  let d = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (d === 0) {
      const m = /^(?:readonly\s+)?(['"]?)([A-Za-z_@$][\w@$]*)\1\??\s*:/.exec(line);
      if (m) fields.push(m[2]);
    }
    d += (line.match(/[{[]/g) ?? []).length - (line.match(/[}\]]/g) ?? []).length;
    if (d < 0) d = 0;
  }
  return [...new Set(fields)];
}
