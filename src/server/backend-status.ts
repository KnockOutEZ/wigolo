export class BackendStatus {
  private _active = false;
  private _reason: string | undefined;
  private _warned = false;
  private _bootstrapping = false;

  get isActive(): boolean { return this._active; }

  markUnhealthy(reason: string): void {
    this._active = false;
    this._reason = reason;
    this._warned = false;
    this._bootstrapping = false;
  }

  markBootstrapping(): void {
    this._active = false;
    this._reason = 'bootstrap in progress';
    this._warned = false;
    this._bootstrapping = true;
  }

  markHealthy(): void {
    this._active = true;
    this._reason = undefined;
    this._warned = false;
    this._bootstrapping = false;
  }

  /** Returns warning text once per fallback session, then undefined. */
  consumeWarning(): string | undefined {
    if (this._active || this._warned) return undefined;
    this._warned = true;
    if (this._bootstrapping) {
      return (
        `SearXNG is still starting up. Results may be lower quality until bootstrap finishes. ` +
        `For best results, run: \`npx @staticn0va/wigolo warmup --all\` before connecting your agent.`
      );
    }
    return (
      `SearXNG embedded search is unavailable; using direct engine scraping (lower quality). ` +
      `Reason: ${this._reason ?? 'unknown'}. ` +
      `To retry: \`npx @staticn0va/wigolo warmup --force\`. ` +
      `For details: \`npx @staticn0va/wigolo doctor\`.`
    );
  }
}
