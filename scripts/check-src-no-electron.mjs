#!/usr/bin/env node
/*
 * Fail the build if anything under src/ imports the `electron` module.
 *
 * The core (src/) is host-agnostic on purpose: Studio is an Electron APP that consumes the
 * core, never the other way round. That one-way dependency is what keeps a future Studio repo
 * split — or a swap of the desktop shell — a SUBSTITUTION rather than a rewrite. The moment a
 * core module reaches for `electron`, the core stops building/running without a desktop shell
 * and the split turns into a refactor. Until this guard existed the property held only by
 * habit; nothing failed a PR that broke it.
 *
 * Scope: `src/` only. `apps/studio/` legitimately imports electron and is never scanned. Pass
 * explicit directories as arguments to scan somewhere else (the tests use this to point the
 * guard at apps/studio and prove it still fires on real electron imports).
 *
 * Detection covers every form that reaches the module — static import, side-effect import,
 * type-only import, re-export, dynamic import(), and require() — in both quote styles and with
 * subpath specifiers (`electron/main`). Matches inside comments and inside string literals are
 * ignored via a small quote/comment scanner, so a docstring or an error message that mentions
 * the import is not a false positive.
 *
 * Known limit: a `require`-alias produced at runtime (e.g. `const req = createRequire(...)`,
 * then `req('electron')`) is not detectable by specifier scanning. `require('electron')` via
 * the conventional `require` name IS caught.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_ROOTS = ['src'];
const EXT = /\.(ts|tsx|js|mjs|cts|mts)$/;

// Exactly the `electron` module or one of its subpaths — never `electron-store`,
// `electron-log`, `@electron/remote` or `./electron-helper`.
const SPECIFIER = String.raw`electron(?:\/[^'"\n]*)?`;

const PATTERNS = [
  // `import … from 'electron'`, `import type … from 'electron'`, `export … from 'electron'`.
  // Anchoring on the `from` clause covers multi-line binding lists for free.
  { id: 'from-clause', re: new RegExp(String.raw`\bfrom\s*['"]${SPECIFIER}['"]`, 'g') },
  { id: 'side-effect-import', re: new RegExp(String.raw`\bimport\s*['"]${SPECIFIER}['"]`, 'g') },
  { id: 'dynamic-import', re: new RegExp(String.raw`\bimport\s*\(\s*['"]${SPECIFIER}['"]`, 'g') },
  { id: 'require', re: new RegExp(String.raw`\brequire\s*\(\s*['"]${SPECIFIER}['"]`, 'g') },
];

const CODE = 0;
const COMMENT = 1;
const STRING = 2;

/*
 * Per-character classification of comment / string-interior / code.
 *
 * Quote characters themselves stay CODE and only the interior is marked STRING, so a real
 * `from 'electron'` (which begins on the `from` keyword) is still code while a mention buried
 * inside `"… from 'electron'"` begins inside a string interior and is skipped.
 *
 * Consuming whole strings before looking for comment openers is what stops `'https://x'` from
 * being read as a line comment. A regex literal containing escaped slashes (/\/\//) can still
 * be misread as a comment opener; that only blinds the REST OF THAT LINE, so an import on a
 * later line is unaffected (tests/unit/electron-quarantine.test.ts pins this).
 */
function classify(text) {
  const kind = new Uint8Array(text.length);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const stop = nl === -1 ? text.length : nl;
      kind.fill(COMMENT, i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      kind.fill(COMMENT, i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        if (c !== '`' && text[j] === '\n') break; // unterminated single-line string
        j++;
      }
      kind.fill(STRING, i + 1, Math.min(j, text.length));
      i = Math.min(j + 1, text.length);
      continue;
    }
    i++;
  }
  return kind;
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line++;
  return line;
}

export function findElectronImports(text) {
  const kind = classify(text);
  const byOffset = new Map();
  for (const { id, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      if (kind[start] !== CODE) continue;
      let commented = false;
      for (let i = start; i < start + m[0].length; i++) {
        if (kind[i] === COMMENT) {
          commented = true;
          break;
        }
      }
      if (commented) continue;
      if (!byOffset.has(start)) {
        byOffset.set(start, { id, line: lineOf(text, start), text: m[0].replace(/\s+/g, ' ') });
      }
    }
  }
  return [...byOffset.values()].sort((a, b) => a.line - b.line);
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a missing root is not a failure
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (EXT.test(entry.name)) out.push(p);
  }
  return out;
}

const roots = process.argv.slice(2);
const targets = (roots.length ? roots : DEFAULT_ROOTS).map((r) => (isAbsolute(r) ? r : join(ROOT, r)));

const offenders = [];
let scanned = 0;
for (const target of targets) {
  for (const file of walk(target)) {
    scanned++;
    for (const hit of findElectronImports(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(ROOT, file)}:${hit.line} [${hit.id}] ${hit.text}`);
    }
  }
}

if (offenders.length) {
  console.error('FAIL: the electron module is imported from quarantined source:');
  for (const o of offenders) console.error('  - ' + o);
  console.error(
    '\nsrc/ must stay host-agnostic — Studio (apps/studio) consumes the core, never the reverse.\nMove the electron-facing code into apps/studio and inject it through the existing host seam.'
  );
  process.exit(1);
}
console.log(`OK: no electron imports in ${targets.map((t) => relative(ROOT, t) || t).join(', ')} (${scanned} files).`);
