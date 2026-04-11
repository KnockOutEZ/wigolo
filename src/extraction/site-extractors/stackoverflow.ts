import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { Extractor, ExtractionResult } from '../../types.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

interface Answer {
  accepted: boolean;
  votes: number;
  bodyHtml: string;
}

function parseVotes(el: Element | null): number {
  if (!el) return 0;
  const voteEl = el.querySelector('.js-vote-count');
  const val = voteEl?.getAttribute('data-value') ?? voteEl?.textContent?.trim() ?? '0';
  return parseInt(val, 10) || 0;
}

function parseAnswers(document: Document): Answer[] {
  const answerEls = document.querySelectorAll('#answers .answer');
  const answers: Answer[] = [];

  for (const el of Array.from(answerEls)) {
    const accepted = el.classList.contains('accepted-answer');
    const votes = parseVotes(el as Element);
    const bodyEl = el.querySelector('.s-prose, .js-post-body, .post-text');
    const bodyHtml = bodyEl ? (bodyEl as Element).innerHTML : '';
    answers.push({ accepted, votes, bodyHtml });
  }

  return answers;
}

function buildMarkdown(
  title: string,
  tags: string[],
  votes: number,
  questionHtml: string,
  answers: Answer[],
): string {
  const tagLine = `Tags: ${tags.join(', ')} | Votes: ${votes}`;
  const questionMd = turndown.turndown(questionHtml).trim();

  const sections: string[] = [
    `# ${title}`,
    tagLine,
    '',
    questionMd,
  ];

  const accepted = answers.filter((a) => a.accepted);
  const others = answers.filter((a) => !a.accepted).sort((a, b) => b.votes - a.votes);
  const ordered = [...accepted, ...others];

  for (const answer of ordered) {
    const heading = answer.accepted
      ? `## Accepted Answer (Votes: ${answer.votes})`
      : `## Answer (Votes: ${answer.votes})`;
    const bodyMd = turndown.turndown(answer.bodyHtml).trim();
    sections.push('---', '', heading, '', bodyMd);
  }

  return sections.join('\n\n');
}

export const stackoverflowExtractor: Extractor = {
  name: 'stackoverflow',

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return hostname === 'stackoverflow.com' ||
        hostname.endsWith('.stackoverflow.com') ||
        hostname === 'stackexchange.com' ||
        hostname.endsWith('.stackexchange.com');
    } catch {
      return false;
    }
  },

  extract(html: string, url: string): ExtractionResult | null {
    if (!html) return null;

    const { document } = parseHTML(html);

    const titleEl = document.querySelector('.question-hyperlink');
    if (!titleEl) return null;

    const title = titleEl.textContent?.trim() ?? '';
    if (!title) return null;

    const questionBodyEl = document.querySelector('#question .s-prose, #question .js-post-body, #question .post-text');
    if (!questionBodyEl) return null;

    const questionHtml = (questionBodyEl as Element).innerHTML;

    const tagEls = document.querySelectorAll('.js-post-tag-list-wrapper .post-tag, .post-taglist .post-tag');
    const tags = Array.from(tagEls).map((el) => el.textContent?.trim() ?? '').filter(Boolean);

    const questionEl = document.querySelector('#question');
    const votes = parseVotes(questionEl as Element | null);

    const answers = parseAnswers(document);

    const markdown = buildMarkdown(title, tags, votes, questionHtml, answers);

    return {
      title,
      markdown,
      metadata: {},
      links: [],
      images: [],
      extractor: 'site-specific',
    };
  },
};
