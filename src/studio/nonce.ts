import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * One-time, short-TTL nonces for the Studio web-app token handshake.
 *
 * The browser tab cannot be handed the long-lived session bearer in its URL (a URL leaks into history,
 * `Referer`, shoulder-surfing, and shell scrollback). Instead the host mints a NONCE — low-value,
 * single-use, short-lived — passes THAT in the tab URL, and the page exchanges it for the bearer over a
 * loopback POST whose body never touches the URL. This store is the nonce half of that exchange:
 *
 *   - SINGLE-USE: `redeem` deletes the nonce on the first success, so a replay (or a leaked URL opened
 *     twice) fails closed.
 *   - TTL-BOUNDED: a nonce older than `ttlMs` is rejected and dropped, so a stale URL cannot be redeemed.
 *   - constant-time match: the lookup compares with `timingSafeEqual` against each live nonce so a redeem
 *     attempt cannot be timing-distinguished by how many bytes it shares with a live value.
 *
 * Pure in-memory mechanism; the clock is injectable for deterministic TTL tests.
 */

export type RedeemResult = { ok: true } | { ok: false; reason: 'unknown_nonce' | 'expired' };

/** Default validity window for a freshly minted nonce — long enough for a tab to open, short enough to bound replay. */
const DEFAULT_TTL_MS = 120_000;

export interface NonceStoreOptions {
  /** Validity window in ms (default 120_000). */
  ttlMs?: number;
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
}

export class NonceStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly issued = new Map<string, number>(); // nonce → issuedAt

  constructor(opts: NonceStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Mint a fresh single-use nonce (URL-safe base64url of 32 random bytes). */
  mint(): string {
    const nonce = randomBytes(32).toString('base64url');
    this.issued.set(nonce, this.now());
    return nonce;
  }

  /**
   * Redeem a presented nonce: succeeds at most once, and only within the TTL. On success the nonce is
   * consumed (single-use). The presented value is matched constant-time against each live nonce.
   */
  redeem(presented: string): RedeemResult {
    const match = this.findConstantTime(presented);
    if (match === null) return { ok: false, reason: 'unknown_nonce' };
    const issuedAt = this.issued.get(match)!;
    // Consume on ANY match (expired or not) so a stale nonce cannot be retried after the clock crosses back.
    this.issued.delete(match);
    if (this.now() - issuedAt > this.ttlMs) return { ok: false, reason: 'expired' };
    return { ok: true };
  }

  /** Live (unredeemed, unexpired-at-call) nonce count — observability/tests. */
  get size(): number {
    return this.issued.size;
  }

  private findConstantTime(presented: string): string | null {
    const presentedBuf = Buffer.from(presented);
    let found: string | null = null;
    for (const nonce of this.issued.keys()) {
      const nonceBuf = Buffer.from(nonce);
      if (nonceBuf.length === presentedBuf.length && timingSafeEqual(nonceBuf, presentedBuf)) {
        found = nonce; // don't break — keep the scan length independent of match position
      }
    }
    return found;
  }
}
