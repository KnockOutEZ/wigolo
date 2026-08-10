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

/**
 * P3-CLASSIFY — a length reading is never a challenge VERDICT.
 *
 * `classifyChallenge`'s final arm used `isChallengeSkeleton` UNPAIRED. That
 * predicate's own sibling docstring says it is "deliberately NOT sufficient on
 * its own — callers pair it with an anti-bot STATUS", and its last arm is a bare
 * `visibleText < 600`. So any page shorter than 600 visible characters and
 * carrying no vendor marker at all classified `behavioral` — a bot wall.
 *
 * Measured live 2026-08-04: `https://example.com/` returns 559 bytes / ~128
 * visible chars at HTTP 200 and classified `behavioral`. `cdpDirectFetch` polls
 * `classifyChallenge(html) === 'none'` as its clear-check and structurally has
 * NO HTTP status to pair with (it navigates and reads the DOM), so it burned the
 * full clear-poll budget and declined a legitimate page as a bot wall.
 *
 * This is the SECOND instance of one pattern — P0 fixed `isAntiBotSignal`, which
 * matched challenge markers ALONE at 2xx so an article *about* bot protection
 * read as a wall. Same shape, opposite half: markers-without-content there,
 * content-without-markers here.
 *
 * The fix is NOT a lower threshold. 600 is untouched; what changed is its
 * LOGICAL ROLE — from a sufficient condition to the corroborating half of a
 * pair. A challenge verdict now requires a positive interstitial ARTIFACT
 * (interstitial title, vendor template signature, or a shared challenge marker).
 * That is why both directions below can hold at once: a page can be legitimately
 * 80 bytes, and an interstitial can be verbose.
 */
describe('classifyChallenge — a short body is not evidence of a bot wall', () => {
  // The literal 559-byte body served by https://example.com/ (captured
  // 2026-08-04). Not a paraphrase: this exact document is the reproduction.
  const EXAMPLE_COM =
    '<!doctype html><html lang="en"><head><title>Example Domain</title>' +
    '<link rel="icon" href="data:,">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{background:#eee;width:60vw;margin:15vh auto;font-family:system-ui,sans-serif}' +
    'h1{font-size:1.5em}div{opacity:0.8}a:link,a:visited{color:#348}</style></head>' +
    '<body><div><h1>Example Domain</h1><p>This domain is for use in documentation examples ' +
    'without needing permission. Avoid use in operations.</p>' +
    '<p><a href="https://iana.org/domains/example">Learn more</a></p></div></body></html>\n';

  describe('MUST-NOT-FIRE — legitimate pages below the content floor', () => {
    it('the measured reproduction: example.com (559 bytes) is clean content, not a wall', () => {
      // The exact case that burned the clear-poll and declined the rung.
      expect(EXAMPLE_COM.length).toBe(559);
      expect(classifyChallenge(EXAMPLE_COM)).toBe('none');
    });

    it('an 80-byte legitimate page is clean — a page may legitimately be tiny', () => {
      // Stated in the slice constraints as the reason a threshold cannot be the
      // decision procedure at ANY value: shortness is not misconduct.
      const tiny = '<html><head><title>OK</title></head><body><p>Deploy succeeded.</p></body></html>';
      expect(tiny.length).toBeLessThan(100);
      expect(classifyChallenge(tiny)).toBe('none');
    });

    it('an un-hydrated SPA shell is clean — that is the SPA path, not the challenge path', () => {
      // Mirrors the shipped rule in tls-tier's isChallengeShell: "a skeleton
      // alone is a plain SPA shell handled by the SPA-empty-content path, not
      // the challenge path". The classifier must agree with it.
      const spa = '<html><head><title>My App</title></head><body><div id="root"></div>' +
        '<script src="/assets/index.js"></script></body></html>';
      expect(classifyChallenge(spa)).toBe('none');
    });

    it('a short genuine error page is clean — a thin 404 is not a bot wall', () => {
      const notFound =
        '<html><head><title>404 Not Found</title></head><body>' +
        '<h1>Not Found</h1><p>The requested page does not exist.</p></body></html>';
      expect(classifyChallenge(notFound)).toBe('none');
    });

    it('a text-light JSON/API landing body is clean', () => {
      const api = '<html><body><pre>{"status":"ok","version":"2.1.0"}</pre></body></html>';
      expect(classifyChallenge(api)).toBe('none');
    });
  });

  /**
   * BRANCH ATTRIBUTION — measured by deleting each return-branch of
   * `classifyChallenge` in turn and recording which tests red. Recorded because
   * a fixture's INTENDED branch and its ACTUAL branch are not the same thing,
   * and only the deletion probe can tell them apart:
   *
   *   step1 behavioralPositive  -> 2 red   (Akamai shell; under-claim precedence)
   *   step2 image               -> 3 red
   *   step3 interactive         -> 3 red
   *   step4 arm1 interstitial   -> 1 red   (the PerimeterX-denied fixture below)
   *   step4 arm2 marker-pair    -> 1 red   (the body-phrase fixture below)
   *   step4 BOTH arms           -> 9 red
   *
   * The must-still-fire fixtures in this block are REALISTIC interstitials, and
   * a realistic interstitial carries both an interstitial title AND a shared
   * marker — so two arms independently reach the right verdict and no SINGLE
   * deletion reds them. They are behaviour regression guards, not branch
   * proofs: each one also passed BEFORE this slice's fix. Branch isolation is
   * supplied by the two dedicated arm tests further down.
   *
   * Two distinct failure modes, only one of which is a defect:
   *   - INTERCEPTED: an EARLIER branch returns, so the intended branch is never
   *     reached and the test cannot fail for the reason it claims. A real bug —
   *     a `dd-loader` fixture here was intercepted by step1 and proved nothing.
   *     Fixed by changing the FIXTURE, never the assertion.
   *   - MULTIPLY COVERED: several branches independently give the right answer.
   *     Not a defect. Making these single-signal to isolate a branch would trade
   *     real interstitial shapes for contrived ones and weaken the suite.
   *
   * The DataDome fixture below never reds even with BOTH step4 arms deleted: it
   * returns at step1 on its sensor markers. It therefore does NOT exercise the
   * code this slice changed, and is kept only as a vendor-coverage guard.
   */
  describe('MUST-STILL-FIRE — a real interstitial served at HTTP 200', () => {
    it('a Cloudflare managed shell is still behavioral', () => {
      // Positive artifact: the interstitial title AND the challenge-platform
      // script. Neither is a length reading.
      const cf =
        '<html><head><title>Just a moment...</title></head><body>' +
        '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>' +
        '<div id="cf-please-wait"></div></body></html>';
      expect(classifyChallenge(cf)).toBe('behavioral');
    });

    it('a DataDome "enable JavaScript" interstitial is still behavioral', () => {
      // DataDome serves this at 200 to mask the block — the case that makes a
      // status-free decision procedure necessary in the first place.
      const dd =
        '<html><head><title>Access denied</title></head><body>' +
        '<p id="cmsg">Please enable JS and disable any ad blocker</p>' +
        '<script>window._dd_s = {};</script></body></html>';
      expect(classifyChallenge(dd)).toBe('behavioral');
    });

    it('a PerimeterX "Robot or human?" interstitial is still behavioral', () => {
      // The zillow/walmart class. Its template markers are in the shared
      // CHALLENGE_MARKERS list, so the pairing has a marker to pair WITH.
      const px =
        '<html><head><title>Robot or human?</title></head><body>' +
        '<div id="px-captcha"></div></body></html>';
      expect(classifyChallenge(px)).toBe('behavioral');
    });

    it('a bare marker with no prose still qualifies — a body that short IS a skeleton', () => {
      // Preserves the assertion tls-tier's isAntiBotSignal docstring makes and
      // tls-tier.test.ts encodes. The marker is the positive half; the tiny body
      // is the corroborating half. Both present → a challenge.
      expect(classifyChallenge('cf-browser-verification')).toBe('behavioral');
    });

    it('a VERBOSE interstitial is still caught — length cannot be the escape hatch either', () => {
      // The symmetric failure the fix must not introduce. A padded interstitial
      // carries >600 visible chars, so a content-length rule alone would release
      // it; the interstitial TITLE outranks length in both directions.
      const padded =
        '<html><head><title>Just a moment...</title></head><body>' +
        `<p>${'We are checking your browser before granting access to this site. '.repeat(30)}</p>` +
        '</body></html>';
      expect(padded.replace(/<[^>]+>/g, ' ').trim().length).toBeGreaterThan(600);
      expect(classifyChallenge(padded)).toBe('behavioral');
    });
  });

  describe('the two arms are BOTH load-bearing — neither is redundant', () => {
    it('an interstitial whose signature is NOT in the shared marker list still fires', () => {
      // `px-captcha-error` (PerimeterX "denied" variant) and the "denied" /
      // "verifying you are human" interstitial titles live in this module's own
      // template/title vocabulary and are absent from tls-tier's shared
      // CHALLENGE_MARKERS. So the marker-pair arm alone would MISS them, and the
      // high-precedence interstitial-signal arm is what catches them. If someone
      // deletes that arm as redundant, this reds.
      const pxDenied =
        '<html><head><title>Access to this page has been denied</title></head>' +
        '<body><div class="px-captcha-error"></div></body></html>';
      expect(classifyChallenge(pxDenied)).toBe('behavioral');
    });

    it('an interstitial whose ONLY signal is a shared body marker still fires', () => {
      // The mirror case, and it has to be chosen carefully. Most shared markers
      // are ALSO caught earlier — `dd-loader` / `_dd_s` / `id="cmsg"` by the
      // behavioral-positive step, the template signatures by the arm above — so
      // using one of those would exercise neither arm and prove nothing. (That
      // exact mistake was made and caught here: a `dd-loader` fixture stayed
      // green with this arm deleted.)
      //
      // `Just a moment` in the BODY is the genuine arm-2-only shape: the title
      // regex requires the phrase inside <title>, no template signature is
      // present, and no behavioral-positive marker matches — so the shared
      // marker paired with the skeleton reading is the ONLY thing that can
      // classify it. Cloudflare renders the phrase as page copy, not only as a
      // title, so this is a real interstitial shape and not a contrivance.
      const bodyPhraseOnly =
        '<html><head><title>Access</title></head><body>' +
        '<h1>Just a moment...</h1><div id="wait"></div></body></html>';
      expect(classifyChallenge(bodyPhraseOnly)).toBe('behavioral');
    });
  });

  /**
   * REGRESSION — removing the length heuristic must not remove VENDOR COVERAGE with it.
   *
   * The arm this slice replaced was `isChallengeSkeleton(slice) || isCloudflareShell(lower)`. Only
   * the `visibleText < 600` arm inside `isChallengeSkeleton` was defective. But that predicate ALSO
   * short-circuits on two positive MARKERS, and `isCloudflareShell` is a pure marker check — so the
   * first version of this fix deleted markers along with the heuristic, and four real wall shapes
   * silently flipped `behavioral` -> `none`.
   *
   * Caught by a BASE-vs-TIP differential (running both revisions of the classifier side by side),
   * not by this suite — every test here was green throughout. Consequence was not cosmetic:
   * `cdpDirectFetch` breaks its clear-poll on `=== 'none'` and returns the body as content at a
   * synthesized HTTP 200, so these walls would have been handed to the agent as real pages.
   */
  describe('vendor coverage the length heuristic was accidentally providing', () => {
    it('an Imperva/Incapsula stub is behavioral', () => {
      const html =
        '<html><head><title>Request unsuccessful.</title></head><body>' +
        '<iframe src="/_Incapsula_Resource?CWUDNSAI=9&xinfo=12-345-0"></iframe></body></html>';
      expect(classifyChallenge(html)).toBe('behavioral');
    });

    it('an Akamai denial (no /akam/ sensor path) is behavioral', () => {
      const html =
        '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>' +
        '<p>You don\'t have permission to access this server.</p>' +
        '<p>Reference #18.1a2b3c4d.1712345678.9abcdef</p></body></html>';
      expect(classifyChallenge(html)).toBe('behavioral');
    });

    it('a modern-CF skeleton with no interstitial title is behavioral', () => {
      // The F3 case: challenge-platform script, near-empty, no catalogued marker, no title. A
      // localized Cloudflare interstitial looks exactly like this, since the title pattern is
      // English-only — so this is not an exotic shape.
      const html =
        '<html><head><meta charset="utf-8"></head><body><div id="challenge-running"></div>' +
        '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>' +
        '</body></html>';
      expect(classifyChallenge(html)).toBe('behavioral');
    });

    it('a LOWERCASE Cloudflare body phrase is behavioral — matching is case-insensitive', () => {
      // The F4 case. The shared marker catalogue compares case-SENSITIVELY against raw HTML, while
      // the removed `isCloudflareShell` compared on the lowercased slice, so a lowercase variant was
      // released. Both cases must classify the same.
      const lower =
        '<html><head><title>Access</title></head><body><h1>just a moment...</h1></body></html>';
      const upper =
        '<html><head><title>Access</title></head><body><h1>Just a moment...</h1></body></html>';
      expect(classifyChallenge(lower)).toBe('behavioral');
      expect(classifyChallenge(upper)).toBe('behavioral');
    });
  });

  /**
   * OVER-FIRE PROBE for the vendor markers. A new marker is a new gate, and the house rule is that
   * a new gate ships with negative tests.
   *
   * EVERY FIXTURE HERE IS SHORT, DELIBERATELY. The first version of this block used long articles,
   * and three of its four cases were VACUOUS: the content guard released them on length before the
   * vendor arm ever ran, so they asserted the content guard and proved nothing about the markers.
   * Forcing `hasVendorTemplateMarker` to `return true` left them green — the interception probe
   * that should have been run when they were written.
   *
   * A negative for a marker paired with a length reading has to be SHORT ENOUGH TO REACH THE ARM,
   * which means it must test the marker's PRECISION rather than the content guard's reach: a short
   * body carrying something marker-adjacent that is not the marker. That is what each case below
   * does, and it is why they double as the regression tests for N1 and N3.
   */
  describe('MUST-NOT-FIRE — short pages that reach the vendor arm and must survive it', () => {
    it('a thin SPA shell behind Cloudflare JS Detections does not fire', () => {
      // N1. JS Detections injects its sensor into pages served SUCCESSFULLY, so the bare
      // `/cdn-cgi/challenge-platform/` prefix means "this zone uses Cloudflare", not "this response
      // is a challenge". Measured 193 bytes, and it classified behavioral — through cdpDirectFetch
      // that is this slice's own defect, narrowed to Cloudflare-protected thin pages.
      const html =
        '<html><head><title>Dashboard</title></head><body><div id="root"></div>' +
        '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>' +
        '<script src="/assets/app.js"></script></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });

    it('a small Cloudflare-fronted landing page does not fire', () => {
      const html =
        '<html><head><title>Acme</title></head><body><h1>Acme</h1><p>Welcome.</p>' +
        '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });

    it('a short page citing the challenge-platform prefix in CSP prose does not fire', () => {
      const html =
        '<html><body><p>Allow /cdn-cgi/challenge-platform/ in your CSP.</p></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });

    it('a short support snippet naming both Akamai phrases does not fire', () => {
      // N3. "Access Denied" is ordinary 403 copy and a bare "Reference #" is ordinary support copy,
      // so the literal phrase pair fired on this 99-byte help text. The rule now requires the id's
      // STRUCTURE, not the words around it.
      const html =
        '<html><body><p>If you see Access Denied, quote the Reference # shown on the page.</p></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });

    it('a genuine app 403 carrying a SHORT reference id does not fire', () => {
      const html =
        '<html><body><h1>Access Denied</h1><p>Reference #4821 — contact your admin.</p></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });

    it('a genuine short 403 saying "Access Denied" with NO reference id does not fire', () => {
      const html =
        '<html><head><title>403 Forbidden</title></head><body><h1>Access Denied</h1>' +
        '<p>You do not have permission to view this resource.</p></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });

    it('a TEXT-LIGHT login page on a vendor-protected zone does not fire', () => {
      // M1, and the test whose absence is half of why M1 shipped.
      //
      // `isChallengeSkeleton` exempts a server-rendered interactive form — a carve-out written for
      // "a text-light login screen". Swapping the corroborator to `isNearEmptyBody` to break a
      // self-corroborating pairing inherited what the new predicate LACKS, and this 299-byte page
      // went 'none' -> 'behavioral': a fresh instance of the defect this slice exists to remove.
      //
      // The suite could not have caught it. The only other login-form test pads its body so the
      // CONTENT GUARD releases it, meaning nothing exercised the exemption at all — while a source
      // comment asserted the gap was "not reachable in practice". This fixture is deliberately
      // SHORT so the content guard cannot rescue it: it reaches the vendor arm and survives on the
      // form exemption or not at all.
      //
      // The MARKER here is load-bearing and was got wrong first time round. An earlier version used
      // Imperva's rider path, which the marker narrowing in this same commit already releases — so
      // deleting the form exemption left the test GREEN and it proved nothing about the carve-out
      // it was written for. The marker must be one that still matches after narrowing, so the
      // exemption is the only thing standing between this page and a 'behavioral' verdict.
      // "Just a moment..." as a submit-status label is ordinary UI copy on exactly this kind of
      // thin login screen, which is what makes it the honest choice rather than a contrivance.
      const html =
        '<html><head><title>Sign in</title></head><body><form action="/login" method="post">' +
        '<input name="email" type="text"><input name="password" type="password">' +
        '<button type="submit">Sign in</button></form>' +
        '<p>Just a moment...</p></body></html>';
      expect(html.length).toBeLessThan(400);
      expect(classifyChallenge(html)).toBe('none');
    });

    it('an Imperva RIDER resource call on a served page does not fire', () => {
      // The second half of M1. Imperva injects `_Incapsula_Resource` into pages it serves
      // SUCCESSFULLY, so the bare path is a sensor, not a template — the same distinction already
      // applied to Cloudflare's JSD path, which the Imperva entry had been left behind by. No form
      // here, so only the marker narrowing can save it.
      const html =
        '<html><head><title>Pricing</title></head><body><h1>Pricing</h1><p>Plans from $9.</p>' +
        '<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script>' +
        '</body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });

    it('a dotted SECTION number is not an Akamai reference id', () => {
      // M2. `[0-9a-f]+(?:\.[0-9a-f]+){2,}` matches `1.2.3`, so a policy citation on a short page
      // classified behavioral — the same over-fire as the literal phrase pair it replaced, one
      // refinement further in. Real ids carry long hex groups; section numbers never do.
      const html =
        '<html><body><h1>Access Denied</h1><p>See reference #1.2.3 of the policy.</p></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });

    it('a short page with "attention required" as ordinary form copy does not fire', () => {
      // The Cloudflare WAF block page is titled "Attention Required! | Cloudflare". The bang is
      // load-bearing; without it the phrase is everyday UI copy.
      const html =
        '<html><body><form action="/save"><p>Attention required: complete all fields.</p>' +
        '<input name="a"><button>Save</button></form></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });
  });

  /**
   * CONTENT-GUARD negatives — long bodies quoting the vendor markers in real prose. Kept, but
   * labelled for what they actually exercise: the >=600-visible-char release at the top of
   * `classifyChallenge`, NOT the vendor arm, which they never reach.
   */
  describe('MUST-NOT-FIRE — substantial articles quoting the vendor markers (content guard)', () => {
    it('an article explaining Imperva does not fire', () => {
      const html =
        '<html><head><title>How Imperva blocks bots</title></head><body><article>' +
        'The interstitial loads an iframe pointing at _Incapsula_Resource with a CWUDNSAI parameter. ' +
        'We explain the whole handshake for engineers below. '.repeat(20) +
        '</article></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });

    it('an article explaining Akamai denials does not fire', () => {
      const html =
        '<html><head><title>Reading Akamai denials</title></head><body><article>' +
        'An Akamai denial renders "Access Denied" plus Reference #18.1a2b3c4d.1712345678.9abcdef. ' +
        'Here is how to read one when debugging your own traffic. '.repeat(20) +
        '</article></body></html>';
      expect(classifyChallenge(html)).toBe('none');
    });
  });

  describe('the pairing invariant, stated directly', () => {
    it('a skeleton-shaped body WITHOUT any vendor artifact is never a challenge', () => {
      // The invariant, independent of any single fixture: take a body short
      // enough that the old length arm fired, and assert that shortness ALONE
      // decides nothing. Adding a marker — and only that — flips the verdict.
      const shortNoMarker = '<html><body><div id="app"></div></body></html>';
      expect(classifyChallenge(shortNoMarker)).toBe('none');

      const shortWithMarker = '<html><body><div id="app"></div>_cfChlOpt</body></html>';
      expect(classifyChallenge(shortWithMarker)).toBe('behavioral');
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
