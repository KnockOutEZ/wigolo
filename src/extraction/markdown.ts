import TurndownService from 'turndown';
import { detectCodeLanguage } from './lang-hints.js';

function longestBacktickRun(s: string): number {
  let max = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 96) {
      cur++;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

const TEXT_NODE = 3;

// Render a table cell as inline markdown. The cell body is flattened to one
// line (a markdown table row cannot contain newlines), but anchors keep their
// `[text](href)` form: `links` is derived by re-parsing the converted markdown,
// so a cell reduced to its textContent renders fine and drops every link in the
// table — on a listing page that is the whole page.
function renderCellInline(node: Node): string {
  if (node.nodeType === TEXT_NODE) return node.nodeValue ?? '';

  const el = node as Element;
  const tag = el.nodeName;
  if (tag === 'SCRIPT' || tag === 'STYLE') return '';
  if (tag === 'BR') return ' ';

  // Collapse runs of whitespace but keep the boundaries: trimming here would
  // glue adjacent inline elements together (`<code>a </code><code>b</code>`
  // -> `ab`). The cell-level render trims once, at the edge that matters.
  const inner = Array.from(el.childNodes).map(renderCellInline).join('').replace(/\s+/g, ' ');

  if (tag === 'A') {
    const href = el.getAttribute('href');
    // Percent-encode rather than drop the link: a pipe would split the row into
    // extra columns, and a paren truncates the URL when `links` is recovered by
    // re-parsing `[text](url)` — `.../Mercury_(planet)` would land in `links` as
    // `.../Mercury_(planet`. %7C/%28/%29 resolve identically.
    if (href) {
      const safe = href.replace(/\|/g, '%7C').replace(/\(/g, '%28').replace(/\)/g, '%29');
      return `[${inner}](${safe})`;
    }
  }

  return inner;
}

export function buildTurndown(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

  // Remove script and style tags entirely
  td.remove(['script', 'style']);

  // Custom rule: convert <table> to markdown table
  td.addRule('table', {
    filter: 'table',
    replacement(_content, node) {
      const el = node as Element;
      const rows: Element[] = Array.from(el.querySelectorAll('tr'));
      if (rows.length === 0) return '';

      const renderCell = (cell: Element): string =>
        Array.from(cell.childNodes)
          .map(renderCellInline)
          .join('')
          .replace(/\s+/g, ' ')
          .trim();

      const renderRow = (row: Element): string => {
        const cells = Array.from(row.querySelectorAll('th, td'));
        return '| ' + cells.map(renderCell).join(' | ') + ' |';
      };

      const headerRow = rows[0];
      const isHeaderRow = headerRow.querySelectorAll('th').length > 0;
      const headerCells = Array.from(headerRow.querySelectorAll('th, td'));
      const separator = '| ' + headerCells.map(() => '---').join(' | ') + ' |';

      if (isHeaderRow) {
        const bodyRows = rows.slice(1);
        const lines = [renderRow(headerRow), separator, ...bodyRows.map(renderRow)];
        return '\n\n' + lines.join('\n') + '\n\n';
      }

      const lines = [renderRow(headerRow), separator, ...rows.slice(1).map(renderRow)];
      return '\n\n' + lines.join('\n') + '\n\n';
    },
  });

  // Suppress thead/tbody/tr/th/td individually since table rule handles the whole node
  td.addRule('tableCell', {
    filter: ['thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
    replacement(content) {
      return content;
    },
  });

  td.addRule('codeBlockLang', {
    filter(node) {
      return node.nodeName === 'PRE' && (node as Element).querySelector('code') !== null;
    },
    replacement(_content, node) {
      const pre = node as Element;
      const code = pre.querySelector('code');
      const cls = code?.getAttribute('class') ?? pre.getAttribute('class') ?? '';
      const lang = detectCodeLanguage(cls);
      const body = code?.textContent ?? pre.textContent ?? '';
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
      return `\n\n${fence}${lang ?? ''}\n${body.replace(/\n+$/, '')}\n${fence}\n\n`;
    },
  });

  return td;
}

const turndown = buildTurndown();

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown.turndown(html);
}

export interface Heading {
  level: number;
  text: string;
  lineIndex: number;
}

export function parseHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headings.push({ level: match[1].length, text: match[2].trim(), lineIndex: i });
    }
  }
  return headings;
}

// Prefix-sum array of char offsets: offsets[i] is the index in
// `lines.join('\n')` at which lines[i] begins.
export function lineStartCharOffsets(lines: string[]): number[] {
  const offsets = new Array<number>(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = acc;
    acc += lines[i].length + 1; // +1 for the '\n' separator
  }
  return offsets;
}

function extractFromHeading(lines: string[], headings: Heading[], headingIdx: number): string {
  const heading = headings[headingIdx];
  const start = heading.lineIndex;

  // Find the next heading of equal or higher level (lower or equal # count)
  let end = lines.length;
  for (let i = headingIdx + 1; i < headings.length; i++) {
    if (headings[i].level <= heading.level) {
      end = headings[i].lineIndex;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

export function extractSection(
  markdown: string,
  section: string,
  sectionIndex = 0,
): { content: string; matched: boolean } {
  const lines = markdown.split('\n');
  const headings = parseHeadings(lines);

  if (headings.length === 0) return { content: markdown, matched: false };

  const lower = section.toLowerCase();
  const indexed = headings.map((h, i) => ({ h, i }));

  // Collect exact matches first
  const exactMatches = indexed.filter(({ h }) => h.text.toLowerCase() === lower);

  // If exact matches satisfy the requested index, use them
  if (exactMatches.length > 0 && sectionIndex < exactMatches.length) {
    const { i } = exactMatches[sectionIndex];
    return { content: extractFromHeading(lines, headings, i), matched: true };
  }

  // Fall back to substring matches (includes exact headings and partial ones)
  const substringMatches = indexed.filter(({ h }) => h.text.toLowerCase().includes(lower));

  if (substringMatches.length === 0 || sectionIndex >= substringMatches.length) {
    return { content: markdown, matched: false };
  }

  const { i } = substringMatches[sectionIndex];
  return { content: extractFromHeading(lines, headings, i), matched: true };
}

/**
 * A markdown link/image DESTINATION cannot span lines. The character class
 * excludes CR and LF for that reason, and the reason is not cosmetic: `[^)]+`
 * matched across newlines, so a page whose `href` carried line breaks put
 * multi-line page prose into `links[]` / `images[]` — arrays typed and
 * consumed as URLs, and shipped to callers without a containment fence
 * (`FetchOutput.links` is returned on every fetch, not behind an opt-in).
 * `resolveRelativeUrls` below then declined to resolve such a target, because
 * ITS pattern is `[^)\s]+`, so the raw text passed straight through.
 *
 * Excluding the line break restores what CommonMark already says — a link
 * destination ends at a line ending in both the bare and the `<...>` form — so
 * nothing a conforming producer emits stops being recognised. A destination
 * containing spaces is still matched: turndown emits those in the bracketed
 * `<a b>` form on one line, and dropping them would lose real links.
 */
export function extractLinksAndImages(markdown: string): { links: string[]; images: string[] } {
  const imagePattern = /!\[[^\]]*\]\(([^)\r\n]+)\)/g;
  const linkPattern = /(?<!!)\[[^\]]*\]\(([^)\r\n]+)\)/g;

  const images = new Set<string>();
  const links = new Set<string>();

  let match: RegExpExecArray | null;

  // Extract images first
  while ((match = imagePattern.exec(markdown)) !== null) {
    images.add(match[1]);
  }

  // Extract links (non-image)
  while ((match = linkPattern.exec(markdown)) !== null) {
    links.add(match[1]);
  }

  return { links: Array.from(links), images: Array.from(images) };
}

const DECORATIVE_URL_MARKERS = [
  'avatar',
  'icon',
  'logo',
  'badge',
  'shield',
  'tracking',
  'pixel',
  'sprite',
  'emoji',
  'favicon',
];

// Single definition of "this image is decorative", shared by the markdown
// filter below and by the content-type passthrough path, which filters its
// derived `images` array rather than rewriting the body.
export function isDecorativeImage(src: string, alt: string): boolean {
  const trimmedAlt = alt.trim();
  const lowerSrc = src.toLowerCase();

  // Tiny animated-GIF tracking pixel / 1x1 beacons
  if (lowerSrc.startsWith('data:image/gif;base64,')) return true;

  // Inline SVG icon data URIs (short = tiny, likely decorative glyph)
  if (lowerSrc.startsWith('data:image/svg+xml') && src.length < 200) return true;

  // URL marks it as decorative regardless of alt
  for (const marker of DECORATIVE_URL_MARKERS) {
    if (lowerSrc.includes(marker)) return true;
  }

  // No alt text + no title = decorative
  return !trimmedAlt;
}

// Drop `![alt](src)` tokens that look decorative. Heuristic only -- keep
// images that have alt text unless the URL clearly marks them decorative.
// Tracking pixels (tiny data-URI gifs) and empty-alt icons are removed.
export function filterDecorativeImages(markdown: string): string {
  if (!markdown) return markdown;
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt: string, src: string) =>
    isDecorativeImage(src, alt) ? '' : match,
  );
}

// Resolve relative `[text](path)` and `![alt](path)` targets against baseUrl.
// Leaves absolute URLs, mailto:, tel:, javascript:, and #fragments untouched.
export function resolveRelativeUrls(markdown: string, baseUrl: string): string {
  if (!markdown || !baseUrl) return markdown;

  const rewrite = (path: string): string => {
    const trimmed = path.trim();
    if (!trimmed) return path;
    if (/^(?:https?:|mailto:|tel:|javascript:|data:)/i.test(trimmed)) return path;
    if (trimmed.startsWith('#')) {
      try {
        return new URL(trimmed, baseUrl).href;
      } catch {
        return path;
      }
    }
    if (trimmed.startsWith('//')) {
      try {
        const base = new URL(baseUrl);
        return `${base.protocol}${trimmed}`;
      } catch {
        return path;
      }
    }
    try {
      return new URL(trimmed, baseUrl).href;
    } catch {
      return path;
    }
  };

  // Image links first so the shared link regex does not rewrite them twice.
  let result = markdown.replace(
    /(!\[[^\]]*\]\()([^)\s]+)(\s*(?:"[^"]*")?\))/g,
    (_m, open, path, close) => `${open}${rewrite(path)}${close}`,
  );

  result = result.replace(
    /(^|[^!])(\[[^\]]*\]\()([^)\s]+)(\s*(?:"[^"]*")?\))/g,
    (_m, pre, open, path, close) => `${pre}${open}${rewrite(path)}${close}`,
  );

  return result;
}
