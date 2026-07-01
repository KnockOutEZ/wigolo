import { extractNews } from '../news.js';

export interface ArticleData {
  title: string;
  body: string;
  url: string;
  author?: string;
  date?: string;
  description?: string;
  language?: string;
}

// extract named_schema=Article on Wikipedia-like pages dumped 30KB of
// references + LaTeX + infobox/navbox chrome — the dominant token-budget
// tax. cleanArticleBody strips:
//   - the references section (heading + ordered list following it)
//   - LaTeX math `$$ … $$` blocks (display math; inline `$ … $` is preserved
//     because that pattern also matches dollar amounts and prices on news
//     pages, and the bench specifically flags display math as the gunk).
//   - residual Wikipedia infobox / navbox markdown tables that the readability
//     extractor occasionally leaks through the HTML→markdown conversion.
export function cleanArticleBody(body: string): string {
  if (!body) return body;
  let cleaned = body;

  // 1. Strip references section: a heading line ("# References", "## References",
  //    "**References**", or plain "References") plus everything until the next
  //    heading or end-of-body. Wikipedia consistently emits "## References" and
  //    "## External links"; both are page chrome, not article prose.
  cleaned = stripReferencesSection(cleaned);

  // 2. Strip LaTeX display math `$$ … $$` blocks (one or many lines). Inline
  //    `$ … $` math is left intact to avoid swallowing dollar-amount text on
  //    finance / news articles.
  cleaned = cleaned.replace(/\$\$[\s\S]*?\$\$/g, '');

  // 3. Strip residual Wikipedia chrome that readability leaks as markdown:
  //    - "Cite this page" / "Wikidata item" navbox cells (markdown table rows)
  //    - "[edit]" / "[ edit ]" inline edit links
  //    - sister-project boxes ("Wikimedia Commons", "Wikiquote", …)
  cleaned = cleaned
    // Markdown table rows that contain known navbox tokens — drop the whole
    // row plus the immediately-following `| --- | --- |` separator line.
    .replace(/^\|[^\n]*\b(?:Cite this page|Wikidata item|Wikimedia Commons|Wikiquote)\b[^\n]*\|[\s]*$\n(?:^\|[\s\-:|]+\|[\s]*$\n?)?/gim, '')
    .replace(/\[\s*edit\s*\]/gi, '');

  // Collapse the multi-blank-line gaps left behind by the strips above so the
  // body reads cleanly.
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function stripReferencesSection(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let inSection = false;
  let sectionHeadingLevel = 0;
  // Recognise: "# References", "## References", "**References**", plain
  // "References" on its own line. Case-insensitive. Also catches "Notes",
  // "Citations", "External links", "Further reading", "See also" — all
  // standard Wikipedia chrome sections downstream of article prose.
  const CHROME_TITLES = /^(?:references|notes|citations|external links|further reading|see also|bibliography)\s*$/i;
  const HEADING_RE = /^(#+)\s+(.+?)\s*$/;
  const BOLD_TITLE_RE = /^\*\*(.+?)\*\*\s*$/;

  for (const line of lines) {
    if (!inSection) {
      const h = line.match(HEADING_RE);
      const bt = line.match(BOLD_TITLE_RE);
      const plain = !h && !bt && CHROME_TITLES.test(line.trim());
      if (h && CHROME_TITLES.test(h[2])) {
        inSection = true;
        sectionHeadingLevel = h[1].length;
        continue;
      }
      if (bt && CHROME_TITLES.test(bt[1])) {
        inSection = true;
        sectionHeadingLevel = 0;
        continue;
      }
      if (plain) {
        inSection = true;
        sectionHeadingLevel = 0;
        continue;
      }
      out.push(line);
      continue;
    }
    // Inside a chrome section — keep dropping until we hit the next heading
    // at the same or shallower level, then resume copying.
    const h = line.match(HEADING_RE);
    if (h) {
      const level = h[1].length;
      if (sectionHeadingLevel === 0 || level <= sectionHeadingLevel) {
        // Re-evaluate: is this also a chrome heading? If so, stay in the
        // sink and update the level. Otherwise resume copy from this line.
        if (CHROME_TITLES.test(h[2])) {
          sectionHeadingLevel = level;
          continue;
        }
        inSection = false;
        out.push(line);
        continue;
      }
    }
    // Plain line inside the chrome sink — drop.
  }
  return out.join('\n');
}

export async function extractArticle(html: string, url: string): Promise<ArticleData | null> {
  const result = await extractNews(html, url);
  if (!result) return null;

  const title = (result.title ?? '').trim();
  const body = cleanArticleBody((result.markdown ?? '').trim());
  if (!title && !body) return null;

  const meta = result.metadata ?? {};
  const data: ArticleData = {
    title,
    body,
    url,
  };
  if (meta.author) data.author = meta.author;
  if (meta.date) data.date = meta.date;
  if (meta.description) data.description = meta.description;
  if (meta.language) data.language = meta.language;

  return data;
}
