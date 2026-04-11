import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter } from '../../../src/crawl/rate-limiter.js';

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    crawlConcurrency: 2,
    crawlDelayMs: 100,
    crawlPrivateConcurrency: 10,
    crawlPrivateDelayMs: 0,
    logLevel: 'error',
    logFormat: 'json',
  }),
  resetConfig: vi.fn(),
}));

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('allows up to concurrency limit simultaneously', async () => {
    const running: boolean[] = [];
    const tasks = Array.from({ length: 2 }, (_, i) =>
      limiter.acquire('https://example.com/page' + i).then((release) => {
        running.push(true);
        return release;
      }),
    );

    const releases = await Promise.all(tasks);
    expect(running).toHaveLength(2);
    releases.forEach((r) => r());
  });

  it('blocks beyond concurrency limit until slot freed', async () => {
    const release1 = await limiter.acquire('https://example.com/a');
    const release2 = await limiter.acquire('https://example.com/b');

    let thirdAcquired = false;
    const thirdPromise = limiter.acquire('https://example.com/c').then((r) => {
      thirdAcquired = true;
      return r;
    });

    // Give a tick for the third to try
    await new Promise((r) => setTimeout(r, 10));
    expect(thirdAcquired).toBe(false);

    release1();
    // After delay, third should acquire
    await new Promise((r) => setTimeout(r, 150)); // 100ms delay + buffer
    const release3 = await thirdPromise;
    expect(thirdAcquired).toBe(true);
    release2();
    release3();
  });

  it('uses relaxed limits for private URLs', async () => {
    const limiterPrivate = new RateLimiter();
    // Private URLs should allow up to 10 concurrent (vs 2 for public)
    const releases: (() => void)[] = [];
    for (let i = 0; i < 5; i++) {
      const release = await limiterPrivate.acquire(`http://localhost:3000/page${i}`);
      releases.push(release);
    }
    // All 5 should have acquired without blocking (private concurrency = 10)
    expect(releases).toHaveLength(5);
    releases.forEach((r) => r());
  });

  it('respects robots.txt crawl-delay override', async () => {
    const start = Date.now();
    limiter.setRobotsCrawlDelay('example.com', 0.2); // 200ms

    const release1 = await limiter.acquire('https://example.com/a');
    release1();

    const release2 = await limiter.acquire('https://example.com/b');
    const elapsed = Date.now() - start;
    release2();

    // Should respect the 200ms robots crawl-delay (higher than config's 100ms)
    expect(elapsed).toBeGreaterThanOrEqual(180); // allow some jitter
  });
});
