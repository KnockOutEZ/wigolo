import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import { getBackgroundIndexQueue } from '../embedding/background-queue.js';
import { titleFromMarkdown } from './url-builder.js';
import type { ReadFileResult } from './types.js';

const log = createLogger('indexing');

const SUMMARY_CHARS = 500;
const MIN_TEXT_LEN = 20;

export function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function summariseForEmbed(title: string, markdown: string): string {
  const summary = markdown.slice(0, SUMMARY_CHARS);
  return `${title}\n${summary}`.trim();
}

/**
 * Enqueue a locally indexed document for background embedding.
 * Mirrors `crawl/index-to-vec.ts` semantics.
 */
export function enqueueIndexEmbed(url: string, title: string, markdown: string): Promise<void> {
  const text = summariseForEmbed(title, markdown);
  if (text.length < MIN_TEXT_LEN) return Promise.resolve();
  const contentHash = hashMarkdown(markdown);
  return getBackgroundIndexQueue().enqueue({ url, text, contentHash });
}

/** Read a local file into markdown. Text formats are sync; PDF is async. */
export async function readLocalFile(absolutePath: string, relativePath: string): Promise<ReadFileResult> {
  const ext = extname(relativePath).toLowerCase();
  const name = relativePath.split(/[/\\]/).pop() ?? relativePath;

  if (ext === '.pdf') {
    const buffer = readFileSync(absolutePath);
    let text = '';
    try {
      const mod = await import('pdf-parse');
      const parser = new mod.PDFParse({ data: buffer });
      const parsed = await parser.getText({});
      text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
      await parser.destroy();
    } catch (err) {
      throw new Error(
        `pdf parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!text) throw new Error('pdf contained no extractable text');
    const markdown = `# ${name}\n\n${text}`;
    return {
      title: titleFromMarkdown(markdown, name),
      markdown,
      mime: 'application/pdf',
      extractorUsed: 'index:pdf',
    };
  }

  const markdown = readFileSync(absolutePath, 'utf-8');
  return {
    title: titleFromMarkdown(markdown, name),
    markdown,
    mime: ext === '.txt' ? 'text/plain' : 'text/markdown',
    extractorUsed: 'index:markdown',
  };
}

export async function enqueueIndexEmbedSafe(
  url: string,
  title: string,
  markdown: string,
): Promise<void> {
  try {
    await enqueueIndexEmbed(url, title, markdown);
  } catch (err) {
    log.warn('embed enqueue failed after index write', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
