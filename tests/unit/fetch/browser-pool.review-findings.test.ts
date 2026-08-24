import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, resetConfig } from '../../../src/config.js';
import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

describe('CodeRabbit browser-pool regressions', () => {
  afterEach(() => {
    delete process.env.WIGOLO_AI_SOLVE;
    resetConfig();
  });

  it('does not resolve a vision provider after the challenge budget is exhausted', async () => {
    process.env.WIGOLO_AI_SOLVE = 'auto';
    resetConfig();
    const pool = new MultiBrowserPool();
    const visionProviderAvailable = vi.fn().mockResolvedValue(true);
    const internals = pool as unknown as {
      visionProviderAvailable: () => Promise<boolean>;
      runChallengeSolveLadder: (args: Record<string, unknown>) => Promise<unknown>;
    };
    internals.visionProviderAvailable = visionProviderAvailable;

    await internals.runChallengeSolveLadder({
      page: {},
      url: 'https://challenge.example/',
      config: getConfig(),
      challengeClass: 'image',
      isStillChallenge: () => true,
      remainingMs: () => 0,
    });

    expect(visionProviderAvailable).not.toHaveBeenCalled();
    await pool.shutdown();
  });

  it('targets the hCaptcha challenge frame slider rather than the checkbox frame', async () => {
    const pool = new MultiBrowserPool();
    const frameLocator = vi.fn();
    const challengeFrame = {
      locator: vi.fn().mockReturnValue({
        first: () => ({
          boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 200, width: 20, height: 10 }),
        }),
      }),
    };
    frameLocator.mockReturnValue({ first: () => challengeFrame });
    const mouse = {
      move: vi.fn().mockResolvedValue(undefined),
      down: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      locator: (selector: string) => ({
        first: () => ({
          count: () => Promise.resolve(selector.includes('/captcha/v1/challenge')),
        }),
      }),
      frameLocator,
      mouse,
    };
    const internals = pool as unknown as {
      dragChallengeSlider: (page: unknown, offsetPx: number) => Promise<void>;
    };

    await internals.dragChallengeSlider(page, 60);

    expect(frameLocator).toHaveBeenCalledWith(
      'iframe[src*="hcaptcha.com"][src*="/captcha/v1/challenge"]',
    );
    expect(mouse.move).toHaveBeenNthCalledWith(1, 110, 205);
    expect(mouse.move).toHaveBeenNthCalledWith(2, 170, 205, { steps: 12 });
    await pool.shutdown();
  });
});
