const ALIASES: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  rust: 'rs',
  golang: 'go',
  shell: 'sh',
};

const PATTERNS = [
  /(?:^|\s)language-([a-z0-9+#-]+)/i,
  /(?:^|\s)lang-([a-z0-9+#-]+)/i,
  /(?:^|\s)hljs-([a-z0-9+#-]+)/i,
  /(?:^|\s)prism-language-([a-z0-9+#-]+)/i,
  /(?:^|\s)highlight-source-([a-z0-9+#-]+)/i,
];

export function detectCodeLanguage(classAttr: string | null | undefined): string | null {
  if (!classAttr) return null;
  for (const re of PATTERNS) {
    const m = classAttr.match(re);
    if (m) {
      const raw = m[1].toLowerCase();
      return ALIASES[raw] ?? raw;
    }
  }
  return null;
}
