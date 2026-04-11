import TurndownService from 'turndown';

function buildTurndown(): TurndownService {
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

      const renderRow = (row: Element): string => {
        const cells = Array.from(row.querySelectorAll('th, td'));
        return '| ' + cells.map(c => c.textContent?.replace(/\n/g, ' ').trim() ?? '').join(' | ') + ' |';
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

  return td;
}

const turndown = buildTurndown();

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown.turndown(html);
}

interface Heading {
  level: number;
  text: string;
  lineIndex: number;
}

function parseHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headings.push({ level: match[1].length, text: match[2].trim(), lineIndex: i });
    }
  }
  return headings;
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

export function extractLinksAndImages(markdown: string): { links: string[]; images: string[] } {
  const imagePattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  const linkPattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

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
