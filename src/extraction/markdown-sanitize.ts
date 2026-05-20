// Post-extraction sanitizer for markdown returned by ensemble extractors.
// Currently targets a Node-docs pattern where tab labels ("javascript",
// "typescript", etc.) leak into a fenced code block as a bare line.

const STRAY_LABELS = new Set([
  'javascript',
  'typescript',
  'mjs',
  'cjs',
  'json',
  'html',
  'css',
  'bash',
  'sh',
  'shell',
  'python',
  'py',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'cpp',
  'c++',
  'csharp',
  'ruby',
  'php',
]);

// Short aliases that can appear *glued* to the first identifier on the first
// line of a fenced block (e.g. the TypeScript docs render `<span>ts</span>` and
// the next token concatenates without a separator → `tsfunction`, `jsconst`).
const GLUED_LANG_PREFIXES: Record<string, string> = {
  ts: 'ts',
  js: 'js',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  sh: 'bash',
  json: 'json',
  html: 'html',
  css: 'css',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
};

// Identifier keywords that commonly follow a stuck language prefix.
const POST_PREFIX_TOKENS = [
  'function', 'const', 'let', 'var', 'class', 'interface', 'type', 'enum',
  'import', 'export', 'async', 'await', 'return', 'if', 'for', 'while',
  'def', 'print', 'echo', 'package', 'public', 'private', 'protected',
  'struct', 'fn', 'pub', 'use', 'mod',
];

function unglueLangPrefix(line: string): { lang?: string; line: string } | null {
  for (const [prefix, lang] of Object.entries(GLUED_LANG_PREFIXES)) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    for (const tok of POST_PREFIX_TOKENS) {
      if (rest.startsWith(tok)) {
        const next = rest.charAt(tok.length);
        if (next === '' || /[\s({<\[]/.test(next)) {
          return { lang, line: rest };
        }
      }
    }
  }
  return null;
}

function isFenceLine(line: string): { open: boolean; close: boolean; lang?: string } {
  const m = line.match(/^(```+|~~~+)([a-zA-Z0-9_+-]*)\s*$/);
  if (!m) return { open: false, close: false };
  const lang = m[2]?.trim() || undefined;
  return { open: !!lang, close: !lang, lang };
}

export function sanitizeExtractedMarkdown(md: string): string {
  if (!md.includes('```') && !md.includes('~~~')) return md;
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceMarker: string | null = null;
  let pendingFirstContentLine = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const f = line.match(/^(```+|~~~+)([a-zA-Z0-9_+-]*)\s*$/);
      if (f) {
        inFence = true;
        fenceMarker = f[1];
        pendingFirstContentLine = true;
        const declaredLang = f[2];
        // 'markdown' is a sentinel many extractors emit when the source code
        // tag didn't carry a language class. Reset it; we'll try to recover
        // the real lang from the first content line below.
        if (declaredLang === 'markdown') {
          out.push(fenceMarker);
        } else {
          out.push(line);
        }
        continue;
      }
      out.push(line);
      continue;
    }
    // inside a fence
    if (fenceMarker && line.startsWith(fenceMarker) && line.replace(fenceMarker, '').trim() === '') {
      inFence = false;
      fenceMarker = null;
      pendingFirstContentLine = false;
      out.push(line);
      continue;
    }
    if (pendingFirstContentLine) {
      pendingFirstContentLine = false;
      const unglued = unglueLangPrefix(line);
      if (unglued) {
        // Replace the most recently pushed fence-open line with one that
        // carries the recovered language tag.
        const lastIdx = out.length - 1;
        const prev = out[lastIdx];
        if (prev.startsWith('```') || prev.startsWith('~~~')) {
          out[lastIdx] = `${prev.match(/^(```+|~~~+)/)![1]}${unglued.lang ?? ''}`;
        }
        out.push(unglued.line);
        continue;
      }
    }
    const trimmed = line.trim();
    if (trimmed && STRAY_LABELS.has(trimmed.toLowerCase()) && !line.includes(' ')) {
      // Drop the stray language label line.
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
