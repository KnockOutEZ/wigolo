import { join } from 'node:path';
import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  env,
} from '@huggingface/transformers';
import type {
  RerankProvider,
  RerankCandidate,
  RerankResult,
} from '../../providers/rerank-provider.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config.js';

const log = createLogger('reranker');

// Cross-encoder reranker via Transformers.js.
//
// The high-level `pipeline('text-classification', ...)` API does not pass
// `text_pair`, so it can't drive a cross-encoder properly. We therefore
// load the tokenizer + sequence-classification model directly: feed
// (query, document) pairs to the tokenizer and read raw logits from the
// model. ms-marco-MiniLM-L-6-v2 is a single-output regressor (num_labels=1)
// where higher logit = more relevant, so the logit is used as the rerank
// score with no further transform.
type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Model = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;

interface LogitsTensor {
  data: ArrayLike<number>;
  dims: number[];
}

export class TransformersRerankProvider implements RerankProvider {
  private tokenizer: Tokenizer | null = null;
  private model: Model | null = null;
  private loadPromise: Promise<{ tokenizer: Tokenizer; model: Model }> | null = null;
  readonly modelId: string;

  constructor() {
    this.modelId = 'Xenova/ms-marco-MiniLM-L-6-v2';
  }

  async warmup(): Promise<void> {
    await this.load();
  }

  private load(): Promise<{ tokenizer: Tokenizer; model: Model }> {
    if (this.tokenizer && this.model) {
      return Promise.resolve({ tokenizer: this.tokenizer, model: this.model });
    }
    if (this.loadPromise) return this.loadPromise;

    log.info('Loading rerank model', { modelId: this.modelId });
    const cacheDir = join(getConfig().dataDir, 'transformers');
    // Direct the library at a writable cache under the wigolo data dir so
    // models don't end up in a user home cache the daemon can't manage.
    env.cacheDir = cacheDir;

    this.loadPromise = Promise.all([
      AutoTokenizer.from_pretrained(this.modelId),
      AutoModelForSequenceClassification.from_pretrained(this.modelId),
    ])
      .then(([tokenizer, model]) => {
        this.tokenizer = tokenizer;
        this.model = model;
        return { tokenizer, model };
      })
      .catch((err) => {
        this.loadPromise = null;
        throw err;
      });

    return this.loadPromise;
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK = candidates.length,
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    const { tokenizer, model } = await this.load();

    // Build batch: query repeated against each document.
    const queries = candidates.map(() => query);
    const docs = candidates.map((c) => c.text);

    const inputs = tokenizer(queries, {
      text_pair: docs,
      padding: true,
      truncation: true,
    });

    const outputs = (await model(inputs)) as { logits: LogitsTensor };
    const logits = outputs.logits;
    // logits shape is [batch, 1] for single-label regression rerankers.
    // For multi-label heads (rare for rerankers) we still take the first
    // value as the relevance score.
    const stride = logits.dims.length >= 2 ? logits.dims[1] : 1;
    const data = logits.data;

    const scored: RerankResult[] = candidates.map((c, i) => ({
      id: c.id,
      score: Number(data[i * stride]),
    }));

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
