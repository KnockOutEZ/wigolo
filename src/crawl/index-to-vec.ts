import { createHash } from 'crypto';
import { createLogger } from '../logger.js';
import { getVectorStore } from '../providers/vector-store.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { getBackgroundIndexQueue } from '../embedding/background-queue.js';
import type { CrawlResultItem } from '../types.js';

const log = createLogger('crawl');

const SUMMARY_CHARS = 500;
const MIN_TEXT_LEN = 20;

export function isIndexingEnabled(): boolean {
  return process.env.WIGOLO_CRAWL_INDEX === '1';
}

function summariseForIndex(item: CrawlResultItem): { text: string; contentHash: string } | null {
  const summary = (item.markdown ?? '').slice(0, SUMMARY_CHARS);
  const text = `${item.title ?? ''}\n${summary}`.trim();
  if (text.length < MIN_TEXT_LEN) return null;
  const contentHash = createHash('sha256').update(item.markdown ?? '').digest('hex');
  return { text, contentHash };
}

/**
 * Enqueue a crawl item for background embedding. Returns a Promise that
 * resolves once the job has been recorded in the queue. In sync mode
 * (`WIGOLO_WAIT_FOR_INDEX=1`) the promise resolves only after the embed
 * + upsert completes; otherwise it resolves immediately and the work
 * runs on the queue's background worker.
 */
export function enqueueIndexCrawl(item: CrawlResultItem): Promise<void> {
  const summary = summariseForIndex(item);
  if (!summary) return Promise.resolve();
  return getBackgroundIndexQueue().enqueue({
    url: item.url,
    text: summary.text,
    contentHash: summary.contentHash,
  });
}

/**
 * Opt-in: embed (title + first 500 chars of markdown) and upsert into the
 * vector store. Errors are logged at debug and swallowed so a misbehaving
 * embed provider can never break a crawl. Disabled by default — gate via
 * WIGOLO_CRAWL_INDEX=1.
 */
export async function indexCrawlResult(item: CrawlResultItem): Promise<void> {
  try {
    const summary = (item.markdown ?? '').slice(0, SUMMARY_CHARS);
    const text = `${item.title ?? ''}\n${summary}`.trim();
    if (text.length < MIN_TEXT_LEN) return;

    const provider = await getEmbedProvider();
    const vectors = await provider.embed([text]);
    if (vectors.length === 0) return;

    const store = await getVectorStore();
    const contentHash = createHash('sha256')
      .update(item.markdown ?? '')
      .digest('hex');

    await store.upsert([
      {
        id: item.url,
        vector: vectors[0],
        metadata: {
          url: item.url,
          contentHash,
          modelId: provider.modelId,
        },
      },
    ]);
  } catch (err) {
    log.warn('crawl index-to-vec failed', {
      url: item.url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
