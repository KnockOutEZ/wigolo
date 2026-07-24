import { describe, it, expect } from 'vitest';
import { classifyChallenge } from '../../../src/fetch/challenge-classify.js';

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
