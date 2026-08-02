import { describe, it, expect } from 'vitest';
import { classifyChallenge, classifyImageSubType } from '../../../src/fetch/challenge-classify.js';

// A minimal challenge-page skeleton: near-empty prose + the modern CF platform
// script + interstitial title. Used to gate contextual widget markers so a real
// full page that merely embeds a widget never trips a challenge class.
const cfSkeleton = (inner: string) => `<!doctype html><html><head>
  <title>Just a moment...</title>
</head><body>
  <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
  ${inner}
</body></html>`;

describe('classifyChallenge', () => {
  describe('interactive — a solvable widget is present to click', () => {
    it('classifies a Cloudflare Turnstile widget as interactive', () => {
      const html = cfSkeleton(`
        <form id="challenge-form" action="/cdn-cgi/challenge-platform/">
          <div class="cf-turnstile" data-sitekey="0x4AAA"></div>
        </form>`);
      expect(classifyChallenge(html)).toBe('interactive');
    });

    it('classifies a reCAPTCHA checkbox anchor as interactive', () => {
      const html = cfSkeleton(`
        <div id="recaptcha-anchor" class="recaptcha-checkbox" role="checkbox"></div>
        <iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc"></iframe>`);
      expect(classifyChallenge(html)).toBe('interactive');
    });

    it('classifies an hCaptcha checkbox iframe as interactive', () => {
      const html = cfSkeleton(`
        <iframe src="https://newassets.hcaptcha.com/captcha/v1/checkbox?sitekey=x"></iframe>`);
      expect(classifyChallenge(html)).toBe('interactive');
    });
  });

  describe('image — a visible image puzzle to solve', () => {
    it('classifies a reCAPTCHA bframe image-select as image', () => {
      const html = cfSkeleton(`
        <iframe src="https://www.google.com/recaptcha/api2/bframe?hl=en&k=abc"
                title="recaptcha challenge"></iframe>`);
      expect(classifyChallenge(html)).toBe('image');
    });

    it('classifies an hCaptcha image-grid challenge iframe as image', () => {
      const html = cfSkeleton(`
        <iframe src="https://newassets.hcaptcha.com/captcha/v1/challenge?sitekey=x"></iframe>`);
      expect(classifyChallenge(html)).toBe('image');
    });

    it('classifies a standalone text-captcha (img + text input) as image', () => {
      const html = `<!doctype html><html><head><title>Verify</title></head><body>
        <form action="/verify">
          <img src="/captcha.php?id=8213" alt="captcha image" />
          <input type="text" name="captcha_code" />
        </form>
      </body></html>`;
      expect(classifyChallenge(html)).toBe('image');
    });
  });

  describe('behavioral — a managed/invisible challenge, no clickable widget, no image', () => {
    it('classifies a Cloudflare managed shell ("Just a moment") as behavioral', () => {
      const html = cfSkeleton(`<div id="cf-please-wait"></div>`);
      expect(classifyChallenge(html)).toBe('behavioral');
    });

    it('classifies a reCAPTCHA v3 badge-only page as behavioral', () => {
      const html = cfSkeleton(`
        <div class="grecaptcha-badge"></div>
        <script>grecaptcha.execute('sitekey', {action: 'submit'});</script>`);
      expect(classifyChallenge(html)).toBe('behavioral');
    });

    it('classifies a DataDome interstitial as behavioral', () => {
      const html = `<!doctype html><html><head><title>Access denied</title></head><body>
        <p id="cmsg">Please enable JS and disable any ad blocker</p>
        <script>window._dd_s = {};</script>
        <script src="https://geo.captcha-delivery.com/captcha/"></script>
      </body></html>`;
      expect(classifyChallenge(html)).toBe('behavioral');
    });

    it('classifies an Akamai bot-manager shell as behavioral', () => {
      const html = `<!doctype html><html><head><title>Access Denied</title></head><body>
        <p>Reference #18.abcd</p>
        <script src="/akam/13/sensor_data"></script>
      </body></html>`;
      expect(classifyChallenge(html)).toBe('behavioral');
    });
  });

  describe('none — real content', () => {
    it('classifies a real article as none', () => {
      const html = `<!doctype html><html><head><title>Ten Great Recipes</title></head><body>
        <article><h1>Ten Great Recipes</h1>
        <p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40)}</p>
        </article>
      </body></html>`;
      expect(classifyChallenge(html)).toBe('none');
    });

    it('classifies empty html as none', () => {
      expect(classifyChallenge('')).toBe('none');
    });
  });

  describe('must-not-fire — benign prose containing challenge vocabulary', () => {
    it('does not fire on an article that discusses "verify", "robot", "are you human"', () => {
      const html = `<!doctype html><html><head><title>How CAPTCHAs Work</title></head><body>
        <article><h1>How CAPTCHAs Work</h1>
        <p>A CAPTCHA asks you to verify that you are human, not a robot.
        Sites use them to challenge automated traffic. ${'Explanatory prose. '.repeat(50)}</p>
        </article>
      </body></html>`;
      expect(classifyChallenge(html)).toBe('none');
    });

    it('does not fire on a marketing page that mentions "captcha" in copy', () => {
      const html = `<!doctype html><html><head><title>Acme Security Suite</title></head><body>
        <main><h1>Acme Security Suite</h1>
        <p>Our product blocks bots with a smart captcha so your users never
        face a challenge. ${'Marketing copy about our features. '.repeat(50)}</p>
        <a href="/pricing">See pricing</a></main>
      </body></html>`;
      expect(classifyChallenge(html)).toBe('none');
    });

    it('a behavioral shell must NOT classify as image or interactive', () => {
      const html = cfSkeleton(`<div id="cf-please-wait"></div>`);
      const result = classifyChallenge(html);
      expect(result).not.toBe('image');
      expect(result).not.toBe('interactive');
      expect(result).toBe('behavioral');
    });

    it('a real login form embedding a Turnstile widget is not misread', () => {
      // Substantial real content + a real server-rendered form → not a challenge
      // skeleton, so the contextual widget marker must not fire.
      const html = `<!doctype html><html><head><title>Sign in — Acme</title></head><body>
        <main>
          <h1>Sign in to Acme</h1>
          <p>${'Welcome back. Enter your credentials to access your account. '.repeat(30)}</p>
          <form action="/login" method="post">
            <input type="email" name="email" />
            <input type="password" name="password" />
            <div class="cf-turnstile" data-sitekey="0x4AAA"></div>
            <button type="submit">Sign in</button>
          </form>
        </main>
      </body></html>`;
      expect(classifyChallenge(html)).toBe('none');
    });
  });

  describe('ambiguity precedence — under-claim solvability', () => {
    it('v3 badge + an image-ish element but no real bframe → behavioral', () => {
      // A grecaptcha-badge (behavioral) co-present with a stray <img> that looks
      // captcha-ish but with NO bframe / grid iframe and NO text input. We must
      // prefer behavioral (never claim an image solve we cannot do).
      const html = cfSkeleton(`
        <div class="grecaptcha-badge"></div>
        <script>grecaptcha.execute('sitekey');</script>
        <img src="/assets/captcha-illustration.png" alt="captcha graphic" />`);
      expect(classifyChallenge(html)).toBe('behavioral');
    });

    it('image + behavioral markers both present → behavioral (under-claim)', () => {
      const html = `<!doctype html><html><head><title>Access denied</title></head><body>
        <script>window._dd_s = {};</script>
        <iframe src="https://www.google.com/recaptcha/api2/bframe?k=abc"></iframe>
      </body></html>`;
      expect(classifyChallenge(html)).toBe('behavioral');
    });
  });
});

describe('classifyImageSubType', () => {
  describe('grid — the common reCAPTCHA / hCaptcha image-select', () => {
    it('classifies a reCAPTCHA bframe image-select as grid', () => {
      const html = `<iframe src="https://www.google.com/recaptcha/api2/bframe?hl=en&k=abc"
                title="recaptcha challenge"></iframe>`;
      expect(classifyImageSubType(html)).toBe('grid');
    });

    it('classifies an hCaptcha image-grid challenge iframe as grid', () => {
      const html = `<iframe src="https://newassets.hcaptcha.com/captcha/v1/challenge?sitekey=x"></iframe>`;
      expect(classifyImageSubType(html)).toBe('grid');
    });

    it('defaults an ambiguous / benign page to grid', () => {
      const html = `<!doctype html><html><head><title>Home</title></head><body>
        <article><p>${'Some ordinary prose. '.repeat(30)}</p></article></body></html>`;
      expect(classifyImageSubType(html)).toBe('grid');
    });

    it('defaults empty html to grid', () => {
      expect(classifyImageSubType('')).toBe('grid');
    });
  });

  describe('slider — a drag-puzzle challenge', () => {
    it('classifies a GeeTest slide-puzzle as slider', () => {
      const html = `<!doctype html><html><body>
        <div class="geetest_slider_button"></div>
        <div class="geetest_slice_bg" style="background:url(slideBg.png)"></div>
      </body></html>`;
      expect(classifyImageSubType(html)).toBe('slider');
    });

    it('classifies a generic slideBg / drag puzzle as slider', () => {
      const html = `<!doctype html><html><body>
        <canvas id="slideBg"></canvas>
        <div class="slider-drag-handle" aria-label="drag to complete the puzzle"></div>
      </body></html>`;
      expect(classifyImageSubType(html)).toBe('slider');
    });
  });

  describe('text — an image captcha with a text input to type the answer', () => {
    it('classifies a captcha <img> + text <input> (no grid / no slider) as text', () => {
      const html = `<!doctype html><html><body>
        <form action="/verify">
          <img src="/captcha.php?id=8213" alt="captcha image" />
          <input type="text" name="captcha_code" />
        </form>
      </body></html>`;
      expect(classifyImageSubType(html)).toBe('text');
    });
  });

  describe('precedence — grid / slider markers win over a bare text-captcha', () => {
    it('a slider marker co-present with a captcha img+input still classifies slider', () => {
      const html = `<!doctype html><html><body>
        <div class="geetest_slider_button"></div>
        <img src="/captcha.png" alt="captcha" />
        <input type="text" name="captcha" />
      </body></html>`;
      expect(classifyImageSubType(html)).toBe('slider');
    });

    it('a grid frame co-present with a captcha img+input still classifies grid', () => {
      const html = `<!doctype html><html><body>
        <iframe src="https://www.google.com/recaptcha/api2/bframe?k=abc"></iframe>
        <img src="/captcha.png" alt="captcha" />
        <input type="text" name="captcha" />
      </body></html>`;
      expect(classifyImageSubType(html)).toBe('grid');
    });
  });

  describe('must-not-misfire — a normal image page is grid, not text', () => {
    it('a page with a plain <img> + a search text input does not classify as text', () => {
      const html = `<!doctype html><html><head><title>Gallery</title></head><body>
        <header><input type="text" name="q" placeholder="Search" /></header>
        <img src="/photos/sunset.jpg" alt="A sunset over the sea" />
        <p>${'Photo gallery copy. '.repeat(30)}</p>
      </body></html>`;
      // No captcha marker on the img/input → the text sub-type must NOT fire; the
      // conservative default is grid.
      expect(classifyImageSubType(html)).toBe('grid');
    });
  });
});

describe('classifyImageSubType — slider detection must not fire on ordinary UI', () => {
  // `sliderish && (puzzle || slide)` was vacuous for the `slider` token, because
  // the string "slider" itself contains "slide". Any page carrying a carousel,
  // range input or `class="slider"` therefore classified as a drag puzzle — and
  // the vision rung would attempt a drag gesture on it.
  it('does NOT call a plain carousel a slider puzzle', () => {
    expect(
      classifyImageSubType('<html><body><div class="slider"><img src="/a.jpg"></div></body></html>'),
    ).not.toBe('slider');
  });

  it('does NOT call a range input a slider puzzle', () => {
    expect(
      classifyImageSubType('<html><body><input type="range" class="volume-slider"></body></html>'),
    ).not.toBe('slider');
  });

  it('still detects a GeeTest slide puzzle', () => {
    expect(classifyImageSubType('<html><body><div class="geetest_slider"></div></body></html>')).toBe('slider');
  });

  it('still detects a slidebg drag puzzle', () => {
    expect(classifyImageSubType('<html><body><div class="slideBg"></div></body></html>')).toBe('slider');
  });

  it('still detects a slider co-present with an explicit puzzle hint', () => {
    expect(
      classifyImageSubType('<html><body><div class="slider">Drag the puzzle piece to verify</div></body></html>'),
    ).toBe('slider');
  });
});
