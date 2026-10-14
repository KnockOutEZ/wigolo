/**
 * Multilingual embedding provider using @huggingface/transformers.
 *
 * Default model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
 *   - 117M params
 *   - 384-dim embeddings
 *   - Trained on 50+ languages including Arabic
 *   - CPU inference: ~150-200ms per query (much faster than the BGE
 *     small-en default for short queries on CPU)
 *   - Quality on Arabic-STS: ~75-78 (vs ~50 for the BGE-small-en-v1.5
 *     default, which is English-only)
 *
 * Drop-in replacement for FastembedEmbedProvider. The interface is the
 * same `EmbedProvider` from `providers/embed-provider.ts`. The factory
 * decides which one to use based on the `embedding.model` config key.
 *
 * Lazy-load: the model is downloaded on the first `warmup()` call to
 * `${dataDir}/transformers` (same cache as the rerank provider). The
 * transformers.js library handles the download from HuggingFace CDN.
 */
import { join } from "node:path";
import {
  AutoTokenizer,
  AutoModel,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import type { EmbedProvider } from "../providers/embed-provider.js";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("embedding");
// Recognize the noisy huggingface fetch failure signature. Same logic as
// the rerank provider.
function wrapLoadError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/tokenizer_class|tokenizer_config|preprocessor_config|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(message)) {
    return new Error(`Embedding model not downloaded — run \`wigolo warmup\` (cause: ${message})`);
  }
  return new Error(`Failed to load embedding model: ${message}`);
}

/**
 * Multilingual ONNX embedding provider using Transformers.js.
 *
 * Pooling: mean-pool over the last_hidden_state, with the attention mask
 * applied (so padded tokens don't contribute to the mean). This is the
 * standard sentence-transformers pooling for MiniLM-style models.
 *
 * Normalization: L2-normalize each pooled vector so cosine similarity
 * reduces to a dot product (cheaper for downstream rerank code).
 */
export class MultilingualEmbedProvider implements EmbedProvider {
  private tokenizer: PreTrainedTokenizer | null = null;
  private model: PreTrainedModel | null = null;
  private loadPromise: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;
  readonly modelId: string;
  readonly dim: number;

  constructor(modelId = "Xenova/paraphrase-multilingual-MiniLM-L12-v2", dim = 384) {
    this.modelId = modelId;
    this.dim = dim;
  }

  async warmup(): Promise<void> {
    await this.load();
  }

  private load(): Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> {
    if (this.tokenizer && this.model) {
      return Promise.resolve({ tokenizer: this.tokenizer, model: this.model });
    }
    if (this.loadPromise) return this.loadPromise;

    log.info("Loading multilingual embedding model", { modelId: this.modelId });
    const cacheDir = join(getConfig().dataDir, "transformers");
    env.cacheDir = cacheDir;

    this.loadPromise = Promise.all([
      AutoTokenizer.from_pretrained(this.modelId),
      AutoModel.from_pretrained(this.modelId, { dtype: "fp32" }),
    ])
      .then(([tokenizer, model]) => {
        this.tokenizer = tokenizer;
        this.model = model;
        log.info("Multilingual embedding model ready", { modelId: this.modelId, dim: this.dim });
        return { tokenizer, model };
      })
      .catch((err: unknown) => {
        this.loadPromise = null;
        throw wrapLoadError(err);
      });

    return this.loadPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const { tokenizer, model } = await this.load();

    const inputs = tokenizer(texts, {
      padding: true,
      truncation: true,
    });

    const outputs = (await model(inputs)) as { last_hidden_state: Tensor };
    const hidden = outputs.last_hidden_state;
    // hidden.dims = [batch, seq_len, hidden_dim]
    // hidden.data is a flat Float32Array in row-major order.
    const batchDim = hidden.dims[0];
    const seqDim = hidden.dims[1];
    const hiddenDim = hidden.dims[2];

    // Mean pool with attention mask. The attention_mask is on `inputs`.
    const attentionMask = (inputs.attention_mask as Tensor).data as ArrayLike<number>;
    const result: Float32Array[] = [];

    for (let b = 0; b < batchDim; b++) {
      const pooled = new Float32Array(hiddenDim);
      let tokenCount = 0;
      for (let s = 0; s < seqDim; s++) {
        // attention_mask: 1 = real token, 0 = padding.
        if (attentionMask[b * seqDim + s] === 1) {
          tokenCount++;
          for (let h = 0; h < hiddenDim; h++) {
            pooled[h] += hidden.data[b * seqDim * hiddenDim + s * hiddenDim + h];
          }
        }
      }
      if (tokenCount > 0) {
        for (let h = 0; h < hiddenDim; h++) {
          pooled[h] /= tokenCount;
        }
      }
      // L2 normalize.
      let norm = 0;
      for (let h = 0; h < hiddenDim; h++) norm += pooled[h] * pooled[h];
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let h = 0; h < hiddenDim; h++) pooled[h] /= norm;
      }
      result.push(pooled);
    }

    return result;
  }
}

// Minimal tensor type to avoid depending on the full @huggingface/transformers
// Tensor interface (which is exported but typed heavily). We only use
// `data` (flat row-major) and `dims`.
interface Tensor {
  data: ArrayLike<number>;
  dims: number[];
}
