import { describe, it, expect } from 'vitest';
import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';
import type { ChallengeClass } from '../../../src/types.js';
import type { ImageSolveSubType } from '../../../src/fetch/ai-solve.js';

// The private `imageSubTypeFor` now delegates to the pure HTML classifier
// (was hardcoded to 'grid'). Reach it through a typed accessor — this proves the
// challenge HTML is threaded in and the detected sub-type is returned, so the
// ai-solve slider/text drivers can actually be selected.
type SubTypeAccessor = {
  imageSubTypeFor(challengeClass: ChallengeClass, html: string): ImageSolveSubType;
};

function subTypeFor(html: string): ImageSolveSubType {
  const pool = new MultiBrowserPool();
  return (pool as unknown as SubTypeAccessor).imageSubTypeFor('image', html);
}

describe('MultiBrowserPool.imageSubTypeFor — wired to the HTML sub-type classifier', () => {
  it('returns "grid" for a reCAPTCHA bframe image-select (default common case)', () => {
    expect(subTypeFor('<iframe src="https://www.google.com/recaptcha/api2/bframe?k=x"></iframe>'))
      .toBe('grid');
  });

  it('returns "slider" for a GeeTest drag puzzle (no longer forced to grid)', () => {
    expect(subTypeFor('<div class="geetest_slider_button"></div>')).toBe('slider');
  });

  it('returns "text" for a captcha image + text input', () => {
    const html = `<form><img src="/captcha.php" alt="captcha" /><input type="text" name="code" /></form>`;
    expect(subTypeFor(html)).toBe('text');
  });

  it('defaults to "grid" when no HTML could be read (empty string)', () => {
    expect(subTypeFor('')).toBe('grid');
  });
});
