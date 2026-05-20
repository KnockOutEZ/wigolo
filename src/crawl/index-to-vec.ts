import { createHash } from 'crypto';
import { createLogger } from '../logger.js';
import { getVectorStore } from '../providers/vector-store.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import type { CrawlResultItem } from '../types.js';

const log = createLogger('crawl');

const SUMMARY_CHARS = 500;
const MIN_TEXT_LEN = 20;

export function isIndexingEnabled(): boolean {
  return process.env.WIGOLO_CRAWL_INDEX === '1';
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
