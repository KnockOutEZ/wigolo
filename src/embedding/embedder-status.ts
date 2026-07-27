/**
 * WHY: when the embedding model can't load, wigolo keeps working — vector
 * rescoring is simply skipped and results fall back to keyword + cross-encoder
 * ranking. That graceful degradation is correct, but until now it was also
 * *invisible*: the only trace was a log line inside the daemon. A container
 * missing its native tokenizer binding would serve measurably worse rankings
 * while `/health` reported healthy and `doctor` reported nothing wrong.
 *
 * This is the one place that records "the embedder is not working", so the
 * search response, the health endpoint, and doctor all read the same fact
 * instead of each guessing. It mirrors `BackendStatus` — a process-wide latch
 * whose warning is emitted once per degradation, not on every response.
 *
 * Two embedding paths exist and they fail independently: the ingest path
 * (`EmbeddingService` — vector store, find_similar) latches off permanently
 * after repeated load failures, while the search-side context rerank retries
 * every call and can recover. They are tracked as separate sources so a
 * recovered rerank path cannot mask a dead ingest path: the reported state is
 * the WORST across sources, never the latest write.
 */

export type EmbedderState = 'unknown' | 'ready' | 'unavailable';
export type EmbedderSource = 'ingest' | 'rerank';

interface SourceState {
  state: EmbedderState;
  reason?: string;
}

class EmbedderStatus {
  private _sources = new Map<EmbedderSource, SourceState>();
  private _warnedKey: string | undefined;

  /** Worst state across sources: any unavailable wins, then any ready, else unknown. */
  get state(): EmbedderState {
    const states = [...this._sources.values()].map((s) => s.state);
    if (states.includes('unavailable')) return 'unavailable';
    if (states.includes('ready')) return 'ready';
    return 'unknown';
  }

  get reason(): string | undefined {
    for (const s of this._sources.values()) {
      if (s.state === 'unavailable') return s.reason;
    }
    return undefined;
  }

  markReady(source: EmbedderSource): void {
    this._sources.set(source, { state: 'ready' });
  }

  markUnavailable(source: EmbedderSource, reason: string): void {
    const prev = this._sources.get(source);
    if (prev?.state === 'unavailable' && prev.reason === reason) return;
    this._sources.set(source, { state: 'unavailable', reason });
  }

  /** Returns warning text once per distinct degradation, then undefined. */
  consumeWarning(): string | undefined {
    if (this.state !== 'unavailable') return undefined;
    const reason = this.reason ?? 'unknown';
    if (this._warnedKey === reason) return undefined;
    this._warnedKey = reason;
    // A missing platform binding is not a download problem: `warmup` re-fetches
    // the model weights, which are already there. Doctor says so, and the two
    // must not contradict each other.
    const remedy = isMissingBindingReason(reason)
      ? `That is a missing native tokenizer binding for this platform, which re-downloading ` +
        `the model does not fix — reinstall wigolo's dependencies with the Node that runs it ` +
        `so the platform binding resolves.`
      : `To install the model: \`npx wigolo warmup --embeddings\`.`;
    return (
      `Vector-similarity ranking is inactive — the embedding model could not be loaded, ` +
      `so results are ranked by keyword and cross-encoder signals only. ` +
      `Reason: ${reason}. ` +
      `${remedy} For details: \`npx wigolo doctor\`.`
    );
  }

  /** Test seam — resets the process-wide latch. */
  reset(): void {
    this._sources.clear();
    this._warnedKey = undefined;
  }
}

/**
 * Whether a recorded failure reason points at an absent native tokenizer
 * binding rather than an absent or corrupt model download. Free-text sniffing
 * on purpose — the reason is an already-stringified error message — but scoped
 * to native-loading vocabulary; a bare "binding" would false-positive on
 * unrelated errors like a socket bind failure.
 */
function isMissingBindingReason(reason: string): boolean {
  return /tokenizer|bindings file|\.node\b|dlopen|@anush008/i.test(reason);
}

let instance: EmbedderStatus | null = null;

export function getEmbedderStatus(): EmbedderStatus {
  instance ??= new EmbedderStatus();
  return instance;
}

export type { EmbedderStatus };
