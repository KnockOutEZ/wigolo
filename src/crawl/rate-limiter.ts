import { isPrivateUrl } from './url-utils.js';
import { getConfig } from '../config.js';

interface DomainState {
  domain: string;
  activeCount: number;
  lastRequestTime: number;
  queue: Array<() => void>;
  maxConcurrency: number;
  delayMs: number;
  // Adaptive cooldown multiplier applied to delayMs. 1 = base pace; grows on
  // 403/429, decays back to 1 on sustained success.
  cooldownMultiplier: number;
  // Consecutive 2xx responses observed since the last cooldown bump.
  successStreak: number;
}

/** Consecutive 2xx responses that decay the cooldown one factor-step back toward base. */
const DECAY_SUCCESS_STREAK = 3;

export interface RateLimiterOptions {
  /** Randomized jitter fraction (0..1). Overrides config for tests. */
  jitterPct?: number;
  /** Cooldown backoff multiplier per 403/429. Overrides config for tests. */
  cooldownFactor?: number;
  /** Ceiling for the cooldown wait in ms. Overrides config for tests. */
  cooldownMaxMs?: number;
  /** Randomness source for jitter. Defaults to Math.random. */
  rng?: () => number;
}

export class RateLimiter {
  private domains = new Map<string, DomainState>();
  private robotsDelays = new Map<string, number>();
  private readonly opts: RateLimiterOptions;

  constructor(opts: RateLimiterOptions = {}) {
    this.opts = opts;
  }

  private get jitterPct(): number {
    const v = this.opts.jitterPct ?? getConfig().crawlJitterPct;
    return Math.max(0, Math.min(1, v));
  }

  private get cooldownFactor(): number {
    return this.opts.cooldownFactor ?? getConfig().crawlCooldownFactor;
  }

  private get cooldownMaxMs(): number {
    return this.opts.cooldownMaxMs ?? getConfig().crawlCooldownMaxMs;
  }

  private get rng(): () => number {
    return this.opts.rng ?? Math.random;
  }

  setRobotsCrawlDelay(domain: string, delaySeconds: number): void {
    this.robotsDelays.set(domain, delaySeconds * 1000);
  }

  /** Ensure per-domain state exists for a URL without acquiring a slot (used by tests + response recording). */
  registerDomain(url: string): void {
    const domain = new URL(url).hostname;
    this.getOrCreateState(url, domain);
  }

  /**
   * Compute the next inter-request wait for a domain: base delay scaled by the
   * adaptive cooldown multiplier, then jittered by +/- jitterPct. Never below
   * the robots crawl-delay floor, never negative. Randomness is injectable so
   * tests are deterministic.
   */
  nextWaitMs(domain: string, rng: () => number = this.rng): number {
    const state = this.domains.get(domain);
    if (!state) return 0;
    return this.computeWait(state, rng);
  }

  private computeWait(state: DomainState, rng: () => number): number {
    const base = state.delayMs * state.cooldownMultiplier;
    // offset in [-jitterPct, +jitterPct]
    const offset = (rng() * 2 - 1) * this.jitterPct;
    let wait = base * (1 + offset);

    // Robots crawl-delay is a hard floor: jitter may extend beyond it, never below.
    const robotsFloor = this.robotsDelays.get(state.domain) ?? 0;
    wait = Math.max(wait, robotsFloor);

    return Math.max(0, wait);
  }

  /**
   * Feed a fetched response's HTTP status back so the limiter can adapt pace
   * per-domain: 403/429 back off (multiply by cooldownFactor, clamped to max),
   * sustained 2xx decays back toward the base delay.
   */
  recordResponse(domain: string, status: number): void {
    const state = this.domains.get(domain);
    if (!state) return;

    if (status === 403 || status === 429) {
      state.successStreak = 0;
      const next = state.cooldownMultiplier * this.cooldownFactor;
      // A ZERO base delay (the default for private hosts) has no meaningful
      // multiplier: scaling it yields 0 either way. Falling back to `next` left
      // the multiplier uncapped, doubling on every block forever — unbounded
      // state that also lies in wait for any later change that gives the domain
      // a non-zero delay. Pin it to 1 instead.
      const maxMultiplier = state.delayMs > 0 ? this.cooldownMaxMs / state.delayMs : 1;
      state.cooldownMultiplier = Math.min(next, Math.max(1, maxMultiplier));
      return;
    }

    if (status >= 200 && status < 300) {
      if (state.cooldownMultiplier <= 1) {
        state.cooldownMultiplier = 1;
        state.successStreak = 0;
        return;
      }
      state.successStreak++;
      if (state.successStreak >= DECAY_SUCCESS_STREAK) {
        state.successStreak = 0;
        const decayed = state.cooldownMultiplier / this.cooldownFactor;
        state.cooldownMultiplier = decayed <= 1 ? 1 : decayed;
      }
    }
  }

  async acquire(url: string): Promise<() => void> {
    const domain = new URL(url).hostname;
    const state = this.getOrCreateState(url, domain);

    if (state.activeCount < state.maxConcurrency) {
      // Enforce jittered delay even when under concurrency limit
      const wait = this.nextWaitMs(domain);
      const elapsed = Date.now() - state.lastRequestTime;
      const remaining = wait - elapsed;
      if (remaining > 0 && state.lastRequestTime > 0) {
        await new Promise<void>((r) => setTimeout(r, remaining));
      }
      return this.startRequest(state);
    }

    // Wait in queue
    return new Promise<() => void>((resolve) => {
      state.queue.push(() => resolve(this.startRequest(state)));
    });
  }

  private getOrCreateState(url: string, domain: string): DomainState {
    if (!this.domains.has(domain)) {
      const config = getConfig();
      const isPrivate = isPrivateUrl(url);
      const configDelay = isPrivate ? config.crawlPrivateDelayMs : config.crawlDelayMs;

      // Use robots.txt delay if it's higher than configured delay
      const robotsDelay = this.robotsDelays.get(domain) ?? 0;
      const effectiveDelay = Math.max(configDelay, robotsDelay);

      this.domains.set(domain, {
        domain,
        activeCount: 0,
        lastRequestTime: 0,
        queue: [],
        maxConcurrency: isPrivate ? config.crawlPrivateConcurrency : config.crawlConcurrency,
        delayMs: effectiveDelay,
        cooldownMultiplier: 1,
        successStreak: 0,
      });
    }

    const state = this.domains.get(domain)!;
    // Update delay if robots delay was set after state creation
    const robotsDelay = this.robotsDelays.get(domain);
    if (robotsDelay !== undefined && robotsDelay > state.delayMs) {
      state.delayMs = robotsDelay;
    }

    return state;
  }

  private startRequest(state: DomainState): () => void {
    state.activeCount++;
    state.lastRequestTime = Date.now();

    return () => {
      state.activeCount--;
      this.processQueue(state);
    };
  }

  private processQueue(state: DomainState): void {
    if (state.queue.length === 0 || state.activeCount >= state.maxConcurrency) return;

    const next = state.queue.shift()!;
    // Recompute a fresh jittered wait for the dequeued request rather than
    // reusing a stale interval, so the queue drains on the same varied pace.
    const wait = this.computeWait(state, this.rng);
    const elapsed = Date.now() - state.lastRequestTime;
    const remaining = wait - elapsed;

    if (remaining <= 0) {
      next();
    } else {
      setTimeout(next, remaining);
    }
  }
}
