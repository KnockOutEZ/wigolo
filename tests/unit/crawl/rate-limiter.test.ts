import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter } from '../../../src/crawl/rate-limiter.js';

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    crawlConcurrency: 2,
    crawlDelayMs: 100,
    crawlPrivateConcurrency: 10,
    crawlPrivateDelayMs: 0,
    crawlJitterPct: 0.3,
    crawlCooldownFactor: 2,
    crawlCooldownMaxMs: 300000,
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

describe('RateLimiter jitter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('applies no jitter offset when rng returns 0.5 (midpoint)', () => {
    // rng 0.5 → offset (0.5*2-1)*pct = 0 → exact base delay
    limiter.registerDomain('https://example.com/a');
    const wait = limiter.nextWaitMs('example.com', () => 0.5);
    expect(wait).toBe(100);
  });

  it('applies max positive jitter when rng returns 1', () => {
    limiter.registerDomain('https://example.com/a');
    // offset = (1*2-1)*0.3 = +0.3 → 100 * 1.3 = 130
    const wait = limiter.nextWaitMs('example.com', () => 1);
    expect(wait).toBeCloseTo(130, 5);
  });

  it('applies max negative jitter when rng returns 0', () => {
    limiter.registerDomain('https://example.com/a');
    // offset = (0*2-1)*0.3 = -0.3 → 100 * 0.7 = 70
    const wait = limiter.nextWaitMs('example.com', () => 0);
    expect(wait).toBeCloseTo(70, 5);
  });

  it('stays within +/- jitterPct of base for arbitrary rng values', () => {
    limiter.registerDomain('https://example.com/a');
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const wait = limiter.nextWaitMs('example.com', () => r);
      expect(wait).toBeGreaterThanOrEqual(70 - 1e-6);
      expect(wait).toBeLessThanOrEqual(130 + 1e-6);
    }
  });

  it('jitterPct=0 yields exact base delay (backwards compatible)', () => {
    const noJitter = new RateLimiter({ jitterPct: 0 });
    noJitter.registerDomain('https://example.com/a');
    for (const r of [0, 0.3, 0.5, 0.8, 1]) {
      expect(noJitter.nextWaitMs('example.com', () => r)).toBe(100);
    }
  });

  it('never goes below the robots crawl-delay floor', () => {
    limiter.setRobotsCrawlDelay('example.com', 0.1); // 100ms floor
    limiter.registerDomain('https://example.com/a');
    // rng 0 → wants 70ms, but robots floor is 100ms
    const wait = limiter.nextWaitMs('example.com', () => 0);
    expect(wait).toBeGreaterThanOrEqual(100);
  });

  it('never returns a negative wait', () => {
    const bigJitter = new RateLimiter({ jitterPct: 1 });
    bigJitter.registerDomain('https://example.com/a');
    // rng 0 → offset -1 → 100 * 0 = 0, not negative
    const wait = bigJitter.nextWaitMs('example.com', () => 0);
    expect(wait).toBeGreaterThanOrEqual(0);
  });
});

describe('RateLimiter adaptive cooldown', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    // jitterPct 0 isolates the cooldown multiplier from jitter noise
    limiter = new RateLimiter({ jitterPct: 0 });
  });

  it('a 429 raises the next wait by the cooldown factor', () => {
    limiter.registerDomain('https://example.com/a');
    expect(limiter.nextWaitMs('example.com', () => 0.5)).toBe(100);
    limiter.recordResponse('example.com', 429);
    expect(limiter.nextWaitMs('example.com', () => 0.5)).toBe(200);
  });

  it('a 403 raises the next wait by the cooldown factor', () => {
    limiter.registerDomain('https://example.com/a');
    limiter.recordResponse('example.com', 403);
    expect(limiter.nextWaitMs('example.com', () => 0.5)).toBe(200);
  });

  it('repeated 429s compound but clamp at the cooldown max', () => {
    const clamped = new RateLimiter({ jitterPct: 0, cooldownMaxMs: 350 });
    clamped.registerDomain('https://example.com/a');
    clamped.recordResponse('example.com', 429); // 200
    clamped.recordResponse('example.com', 429); // 400 -> clamped 350
    clamped.recordResponse('example.com', 429); // stays clamped
    expect(clamped.nextWaitMs('example.com', () => 0.5)).toBe(350);
  });

  it('consecutive successes decay the cooldown back toward base', () => {
    limiter.registerDomain('https://example.com/a');
    limiter.recordResponse('example.com', 429);
    limiter.recordResponse('example.com', 429);
    expect(limiter.nextWaitMs('example.com', () => 0.5)).toBe(400);

    // enough consecutive 2xx to decay all the way back to base
    for (let i = 0; i < 20; i++) limiter.recordResponse('example.com', 200);
    expect(limiter.nextWaitMs('example.com', () => 0.5)).toBe(100);
  });

  it('cooldown is per-domain: domain A 429 does not slow domain B', () => {
    limiter.registerDomain('https://a.example.com/x');
    limiter.registerDomain('https://b.example.com/y');
    limiter.recordResponse('a.example.com', 429);
    expect(limiter.nextWaitMs('a.example.com', () => 0.5)).toBe(200);
    expect(limiter.nextWaitMs('b.example.com', () => 0.5)).toBe(100);
  });

  it('2xx on a fresh domain keeps it at base', () => {
    limiter.registerDomain('https://example.com/a');
    limiter.recordResponse('example.com', 200);
    expect(limiter.nextWaitMs('example.com', () => 0.5)).toBe(100);
  });

  it('recordResponse on an unregistered domain is a no-op', () => {
    expect(() => limiter.recordResponse('never-seen.com', 429)).not.toThrow();
  });
});

describe('RateLimiter — cooldown stays bounded when the base delay is zero', () => {
  // crawlPrivateDelayMs defaults to 0, so delayMs === 0 is the NORMAL state for
  // private hosts. maxMultiplier fell back to `next` there, leaving the
  // multiplier uncapped: it doubled on every 403/429 forever, and any later
  // change that made a zero base delay non-zero would inherit an absurd wait.
  it('does not grow the multiplier without bound on repeated blocks', () => {
    const rl = new RateLimiter({ cooldownFactor: 2, cooldownMaxMs: 30_000, jitterPct: 0, rng: () => 0.5 });
    rl.registerDomain('http://zero.example/a');
    // Force the zero-base-delay state this guards.
    (rl as unknown as { domains: Map<string, { delayMs: number }> }).domains.get('zero.example')!.delayMs = 0;

    for (let i = 0; i < 40; i++) rl.recordResponse('zero.example', 429);

    const m = (rl as unknown as { domains: Map<string, { cooldownMultiplier: number }> })
      .domains.get('zero.example')!.cooldownMultiplier;
    expect(Number.isFinite(m)).toBe(true);
    expect(m).toBeLessThanOrEqual(1);
    // And the wait it produces is still sane.
    expect(rl.nextWaitMs('zero.example')).toBe(0);
  });

  it('still caps a NON-zero base delay at cooldownMaxMs', () => {
    const rl = new RateLimiter({ cooldownFactor: 2, cooldownMaxMs: 4_000, jitterPct: 0, rng: () => 0.5 });
    rl.registerDomain('http://slow.example/a');
    (rl as unknown as { domains: Map<string, { delayMs: number }> }).domains.get('slow.example')!.delayMs = 1_000;

    for (let i = 0; i < 20; i++) rl.recordResponse('slow.example', 403);

    expect(rl.nextWaitMs('slow.example')).toBeLessThanOrEqual(4_000);
  });
});
