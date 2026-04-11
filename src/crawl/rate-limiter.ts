import { isPrivateUrl } from './url-utils.js';
import { getConfig } from '../config.js';

interface DomainState {
  activeCount: number;
  lastRequestTime: number;
  queue: Array<() => void>;
  maxConcurrency: number;
  delayMs: number;
}

export class RateLimiter {
  private domains = new Map<string, DomainState>();
  private robotsDelays = new Map<string, number>();

  setRobotsCrawlDelay(domain: string, delaySeconds: number): void {
    this.robotsDelays.set(domain, delaySeconds * 1000);
  }

  async acquire(url: string): Promise<() => void> {
    const domain = new URL(url).hostname;
    const state = this.getOrCreateState(url, domain);

    if (state.activeCount < state.maxConcurrency) {
      // Enforce delay even when under concurrency limit
      const elapsed = Date.now() - state.lastRequestTime;
      const remaining = state.delayMs - elapsed;
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
        activeCount: 0,
        lastRequestTime: 0,
        queue: [],
        maxConcurrency: isPrivate ? config.crawlPrivateConcurrency : config.crawlConcurrency,
        delayMs: effectiveDelay,
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
    const elapsed = Date.now() - state.lastRequestTime;
    const remaining = state.delayMs - elapsed;

    if (remaining <= 0) {
      next();
    } else {
      setTimeout(next, remaining);
    }
  }
}
