import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from '../markdown.js';
import type { Extractor, ExtractionResult } from '../../types.js';

function isIssueOrPR(url: string): boolean {
  return /\/issues\/\d+|\/pull\/\d+/.test(url);
}

function isBlob(url: string): boolean {
  return /\/blob\//.test(url);
}

/**
 * Injected raw fetcher for the fallback path. Takes a fully-formed
 * raw.githubusercontent.com URL and returns the file body as text. Injected so
 * tests mock it and no real network access happens inside the sync extractor.
 */
export type RawBlobFetcher = (url: string) => Promise<string>;

/** Shape of the modern GitHub blob React payload we read (only the fields we need). */
interface EmbeddedBlobPayload {
  rawLines: string[];
  displayName: string | null;
  language: string | null;
  truncated: boolean;
}

/**
 * Modern GitHub blob view ships file content inside a
 * `<script type="application/json" data-target="react-app.embeddedData">` tag.
 * The blob metadata lives under `payload.codeViewBlobLayoutRoute.blob` and the
 * content lines under `payload["codeViewBlobLayoutRoute.StyledBlob"].rawLines`.
 * Returns null when the tag / expected shape is absent (old cached pages).
 */
function parseEmbeddedBlob(document: Document): EmbeddedBlobPayload | null {
  const scripts = document.querySelectorAll(
    'script[type="application/json"][data-target="react-app.embeddedData"]',
  );

  for (const script of Array.from(scripts)) {
    const raw = script.textContent;
    if (!raw) continue;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }

    const payload = (json as { payload?: Record<string, unknown> } | null)?.payload;
    if (!payload || typeof payload !== 'object') continue;

    const styled = (payload as Record<string, unknown>)['codeViewBlobLayoutRoute.StyledBlob'] as
      | { rawLines?: unknown }
      | undefined;
    const rawLines = styled?.rawLines;
    if (!Array.isArray(rawLines)) continue;

    const blobMeta = (
      (payload as Record<string, unknown>)['codeViewBlobLayoutRoute'] as
        | { blob?: Record<string, unknown> }
        | undefined
    )?.blob;

    const displayName =
      typeof blobMeta?.displayName === 'string' ? blobMeta.displayName : null;
    const language = typeof blobMeta?.language === 'string' ? blobMeta.language : null;
    const truncated = blobMeta?.truncated === true;

    return {
      rawLines: rawLines.filter((line): line is string => typeof line === 'string'),
      displayName,
      language,
      truncated,
    };
  }

  return null;
}

/**
 * Transform a github.com blob URL into its raw.githubusercontent.com equivalent.
 * `https://github.com/<owner>/<repo>/blob/<ref>/<path>` →
 * `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`.
 * Returns null when the URL is not a blob URL.
 */
function toRawUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (!match) return null;
  const [, owner, repo, rest] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
}

/**
 * Map a GitHub payload language name to a markdown fence tag. GitHub's language
 * names ("TypeScript", "Python") are lowercased for the fence; unknown/null
 * languages yield an untagged fence.
 */
function fenceTag(language: string | null): string {
  if (!language) return '';
  return language.toLowerCase().replace(/[^a-z0-9+#-]/g, '');
}

function blobResultFromLines(
  lines: string[],
  displayName: string | null,
  language: string | null,
  fallbackTitle: string,
): ExtractionResult | null {
  const content = lines.join('\n');
  if (!content.trim()) return null;

  const tag = fenceTag(language);
  const markdown = `\`\`\`${tag}\n${content}\n\`\`\``;

  return {
    title: displayName ?? fallbackTitle,
    markdown,
    metadata: language ? { language } : {},
    links: [],
    images: [],
    extractor: 'site-specific',
  };
}

function extractIssue(document: Document, _url: string): ExtractionResult | null {
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
    const md = htmlToMarkdown(html).trim();
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

  const markdown = htmlToMarkdown((readmeBody as Element).innerHTML).trim();
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

function extractBlobLegacy(document: Document, title: string): ExtractionResult | null {
  const codeBlock =
    document.querySelector('.blob-code-content') ??
    document.querySelector('.highlight') ??
    document.querySelector('.markdown-body');

  if (!codeBlock) return null;

  const markdown = htmlToMarkdown((codeBlock as Element).innerHTML).trim();
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

/**
 * Blob extraction (sync). Modern React `react-app.embeddedData` payload first;
 * legacy server-rendered selectors as the final fallback (old cached pages /
 * enterprise instances). Does NOT perform the raw-fetch fallback — that lives in
 * `extractGithubBlobWithRawFallback` so the injected network access stays out of
 * the synchronous `Extractor.extract` contract.
 */
function extractBlob(document: Document): ExtractionResult | null {
  const titleEl = document.querySelector('title');
  const title = titleEl?.textContent?.trim() ?? '';

  const embedded = parseEmbeddedBlob(document);
  if (embedded && !embedded.truncated && embedded.rawLines.length > 0) {
    const result = blobResultFromLines(
      embedded.rawLines,
      embedded.displayName,
      embedded.language,
      title,
    );
    if (result) return result;
  }

  return extractBlobLegacy(document, title);
}

/**
 * Full blob extraction with the raw-content network fallback.
 *
 * Tries local (sync) extraction first — modern embedded payload, then legacy
 * selectors. Only when the payload is ABSENT or TRUNCATED (large files GitHub
 * refuses to inline) does it fetch the file body from raw.githubusercontent.com
 * via the injected `fetchRaw`. A complete payload NEVER triggers a second fetch.
 *
 * The fetcher is injected (not called directly) so the sync `Extractor.extract`
 * contract is preserved and tests mock the network. On fetch failure it returns
 * whatever local extraction produced (possibly null) rather than throwing.
 */
export async function extractGithubBlobWithRawFallback(
  html: string,
  url: string,
  fetchRaw: RawBlobFetcher,
): Promise<ExtractionResult | null> {
  if (!html) return null;

  const { document } = parseHTML(html);
  const embedded = parseEmbeddedBlob(document);

  const payloadUsable = embedded && !embedded.truncated && embedded.rawLines.length > 0;

  // Complete modern payload — extract locally, no network.
  if (payloadUsable) {
    return extractBlob(document);
  }

  // Legacy selectors present — extract locally, no network.
  const legacy = extractBlobLegacy(
    document,
    document.querySelector('title')?.textContent?.trim() ?? '',
  );
  if (legacy) return legacy;

  // Payload absent/truncated and no legacy content — fall back to the raw host.
  const rawUrl = toRawUrl(url);
  if (!rawUrl) return null;

  let body: string;
  try {
    body = await fetchRaw(rawUrl);
  } catch {
    return null;
  }

  if (!body.trim()) return null;

  const title = embedded?.displayName ?? document.querySelector('title')?.textContent?.trim() ?? '';
  return blobResultFromLines(body.split('\n'), embedded?.displayName ?? null, embedded?.language ?? null, title);
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
