import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { Extractor, ExtractionResult } from '../../types.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

function isIssueOrPR(url: string): boolean {
  return /\/issues\/\d+|\/pull\/\d+/.test(url);
}

function isBlob(url: string): boolean {
  return /\/blob\//.test(url);
}

function extractIssue(document: Document, url: string): ExtractionResult | null {
  const titleEl = document.querySelector('.js-issue-title') ?? document.querySelector('.gh-header-title');
  if (!titleEl) return null;

  const title = titleEl.textContent?.trim() ?? '';

  const labelEls = document.querySelectorAll('.IssueLabel');
  const labels = Array.from(labelEls)
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean);

  const commentBodies = document.querySelectorAll('.d-block.comment-body');
  if (commentBodies.length === 0) return null;

  const sections: string[] = [];

  if (labels.length > 0) {
    sections.push(`**Labels:** ${labels.join(', ')}\n`);
  }

  Array.from(commentBodies).forEach((body, i) => {
    const html = (body as Element).innerHTML;
    const md = turndown.turndown(html).trim();
    if (md) {
      sections.push(i === 0 ? md : `---\n\n${md}`);
    }
  });

  const markdown = sections.join('\n\n');

  return {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'site-specific',
  };
}

function extractReadme(document: Document): ExtractionResult | null {
  const titleEl = document.querySelector('title');
  const rawTitle = titleEl?.textContent?.trim() ?? '';
  const title = rawTitle.split(':')[0]?.trim() ?? rawTitle;

  const readmeBody =
    document.querySelector('#readme .markdown-body') ??
    document.querySelector('.markdown-body');

  if (!readmeBody) return null;

  const markdown = turndown.turndown((readmeBody as Element).innerHTML).trim();
  if (!markdown) return null;

  return {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'site-specific',
  };
}

function extractBlob(document: Document): ExtractionResult | null {
  const titleEl = document.querySelector('title');
  const title = titleEl?.textContent?.trim() ?? '';

  const codeBlock =
    document.querySelector('.blob-code-content') ??
    document.querySelector('.highlight') ??
    document.querySelector('.markdown-body');

  if (!codeBlock) return null;

  const markdown = turndown.turndown((codeBlock as Element).innerHTML).trim();
  if (!markdown) return null;

  return {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'site-specific',
  };
}

export const githubExtractor: Extractor = {
  name: 'github',

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return hostname === 'github.com' || hostname.endsWith('.github.com');
    } catch {
      return false;
    }
  },

  extract(html: string, url: string): ExtractionResult | null {
    if (!html) return null;

    const { document } = parseHTML(html);

    if (isIssueOrPR(url)) {
      return extractIssue(document, url);
    }

    if (isBlob(url)) {
      return extractBlob(document);
    }

    return extractReadme(document);
  },
};
