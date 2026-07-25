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
 * instead of each guessing. It deliberately mirrors `BackendStatus` — a
 * process-wide latch with a warning that is emitted once per session, so a
 * degraded setup is reported without spamming every single response.
 */

export type EmbedderState = 'unknown' | 'ready' | 'unavailable';

class EmbedderStatus {
  private _state: EmbedderState = 'unknown';
  private _reason: string | undefined;
  private _warned = false;

  get state(): EmbedderState {
    return this._state;
  }

  get reason(): string | undefined {
    return this._reason;
  }

  markReady(): void {
    this._state = 'ready';
    this._reason = undefined;
  }

  /**
   * Records that vector ranking is off. Re-arms the warning only on a change
   * of reason, so a persistent failure stays quiet after it has been reported.
   */
  markUnavailable(reason: string): void {
    if (this._state === 'unavailable' && this._reason === reason) return;
    this._state = 'unavailable';
    this._reason = reason;
    this._warned = false;
  }

  /** Returns warning text once per degradation, then undefined. */
  consumeWarning(): string | undefined {
    if (this._state !== 'unavailable' || this._warned) return undefined;
    this._warned = true;
    const reason = this._reason ?? 'unknown';
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
    this._state = 'unknown';
    this._reason = undefined;
    this._warned = false;
  }
}

/**
 * Whether a recorded failure reason points at an absent native tokenizer
 * binding rather than an absent or corrupt model download.
 */
function isMissingBindingReason(reason: string): boolean {
  return /tokenizer|binding|\.node\b|dlopen|@anush008/i.test(reason);
}

let instance: EmbedderStatus | null = null;

export function getEmbedderStatus(): EmbedderStatus {
  instance ??= new EmbedderStatus();
  return instance;
}

export type { EmbedderStatus };
