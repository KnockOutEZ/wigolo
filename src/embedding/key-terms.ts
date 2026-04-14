import { createLogger } from '../logger.js';

const log = createLogger('embedding');

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'were',
  'been', 'are', 'am', 'has', 'have', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'not', 'no',
  'nor', 'so', 'yet', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'than', 'too', 'very', 'just', 'about', 'above', 'after',
  'again', 'all', 'also', 'any', 'because', 'before', 'below', 'between',
  'during', 'further', 'here', 'how', 'into', 'its', 'itself', 'me', 'my',
  'myself', 'once', 'only', 'our', 'ours', 'ourselves', 'out', 'over',
  'own', 'same', 'she', 'he', 'her', 'him', 'his', 'hers', 'that', 'their',
  'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'under', 'until', 'up', 'we', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'you', 'your', 'yours', 'yourself',
  'i', 'if',
]);

const MAX_TERMS = 20;
const FIRST_PARAGRAPH_MAX_CHARS = 200;

/**
 * Extract key terms from page content and title for FTS5 query building.
 * Prioritizes: title words > headings > bold text > first paragraph.
 * Returns up to 20 deduplicated, lowercased, stopword-free terms.
 */
export function extractKeyTerms(content: string, title: string): string[] {
  try {
    if (!content.trim() && !title.trim()) {
      return [];
    }

    const allTerms: string[] = [];

    const titleWords = tokenize(title);
    allTerms.push(...titleWords);

    const headings = extractHeadings(content);
    for (const heading of headings) {
      allTerms.push(...tokenize(heading));
    }

    const boldPhrases = extractBoldText(content);
    for (const phrase of boldPhrases) {
      allTerms.push(...tokenize(phrase));
    }

    const firstPara = extractFirstParagraph(content);
    if (firstPara) {
      allTerms.push(...tokenize(firstPara));
    }

    const cleaned = removeStopwords(allTerms);
    const seen = new Set<string>();
    const unique: string[] = [];

    for (const term of cleaned) {
      if (!seen.has(term)) {
        seen.add(term);
        unique.push(term);
      }
      if (unique.length >= MAX_TERMS) break;
    }

    log.debug('extracted key terms', {
      titleTerms: titleWords.length,
      headingTerms: headings.length,
      boldTerms: boldPhrases.length,
      uniqueTerms: unique.length,
    });

    return unique;
  } catch (err) {
    log.error('key term extraction failed', { error: String(err) });
    return [];
  }
}

function tokenize(text: string): string[] {
  if (!text) return [];

  let cleaned = text.replace(/https?:\/\/[^\s)]+/g, '');
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/`[^`]+`/g, '');
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');
  cleaned = cleaned.replace(/\*{1,3}|_{1,3}/g, '');

  return cleaned
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(w => w.length > 1 && !/^\d+$/.test(w));
}

export function removeStopwords(words: string[]): string[] {
  return words.filter(w => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
}

export function extractHeadings(content: string): string[] {
  if (!content) return [];

  const headings: string[] = [];
  const regex = /^#{1,3}\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const text = match[1].trim();
    if (text) headings.push(text);
  }

  return headings;
}

export function extractBoldText(content: string): string[] {
  if (!content) return [];

  const bold: string[] = [];
  const regex = /\*\*(.+?)\*\*|__(.+?)__/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const text = (match[1] || match[2]).trim();
    if (text) bold.push(text);
  }

  return bold;
}

export function extractFirstParagraph(content: string): string {
  if (!content) return '';

  const lines = content.split('\n');
  const paragraphLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('```')) continue;

    paragraphLines.push(trimmed);
    const joined = paragraphLines.join(' ');
    if (joined.length >= FIRST_PARAGRAPH_MAX_CHARS) {
      return joined.slice(0, FIRST_PARAGRAPH_MAX_CHARS);
    }

    break;
  }

  return paragraphLines.join(' ').slice(0, FIRST_PARAGRAPH_MAX_CHARS);
}

export function buildFTS5Query(terms: string[]): string {
  if (terms.length === 0) return '';

  const escaped = terms.map(t => t.replace(/['"()]/g, ''));
  return escaped.filter(Boolean).join(' OR ');
}
