export class BackendStatus {
  private _active = false;
  private _reason: string | undefined;
  private _warned = false;

  get isActive(): boolean { return this._active; }

  markUnhealthy(reason: string): void {
    this._active = false;
    this._reason = reason;
    this._warned = false;
  }

  markHealthy(): void {
    this._active = true;
    this._reason = undefined;
    this._warned = false;
  }

  /** Returns warning text once per fallback session, then undefined. */
  consumeWarning(): string | undefined {
    if (this._active || this._warned) return undefined;
    this._warned = true;
    return (
      `SearXNG embedded search is unavailable; using direct engine scraping (lower quality). ` +
      `Reason: ${this._reason ?? 'unknown'}. ` +
      `To retry: \`npx @staticn0va/wigolo warmup --force\`. ` +
      `For details: \`npx @staticn0va/wigolo doctor\`.`
    );
  }
}
