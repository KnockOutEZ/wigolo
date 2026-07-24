import type { ChallengeClass } from '../types.js';
import { isChallengeSkeleton, isNearEmptyBody } from './tls-tier.js';

/**
 * Pure challenge classifier (the solve-ladder gatekeeper). Given the raw HTML
 * of a page already known/suspected to be a bot-protection challenge, decide
 * WHICH solve rung (if any) is applicable:
 *
 *   - 'interactive' : a clickable widget is present (Turnstile checkbox,
 *                     reCAPTCHA / hCaptcha checkbox) — a trusted gesture can
 *                     pass it; no image to read.
 *   - 'image'       : a visible-image puzzle to solve (reCAPTCHA image-select
 *                     bframe, hCaptcha image grid, standalone text-captcha) —
 *                     pixels an in-band vision model can reason about.
 *   - 'behavioral'  : a managed/invisible challenge with NO clickable widget and
 *                     NO image (managed Turnstile shell, reCAPTCHA v3 badge,
 *                     DataDome, Akamai) — not "solvable", only avoidable via
 *                     fingerprint / IP / behaviour.
 *   - 'none'        : real content, no challenge markers.
 *
 * LOAD-BEARING PRECEDENCE — under-claim solvability. Solvability increases
 * behavioral < image < interactive, but our CONFIDENCE that we can honestly
 * solve decreases in that same direction. On ANY ambiguity we prefer the
 * LEAST-capable class so we never claim we can solve what we can't:
 *
 *   1. A behavioral marker present ALONGSIDE image and/or interactive markers
 *      => 'behavioral'. (A managed shell can inject a fake widget; a v3 badge
 *      co-present with a stray image is not an image puzzle.)
 *   2. Otherwise an image marker => 'image' (we would rather NOT auto-click a
 *      grid than pretend a grid is a one-click checkbox).
 *   3. Otherwise an interactive marker => 'interactive'.
 *   4. Nothing matches => 'none'.
 *
 * Marker vocabulary is REUSED from the shipped detector (tls-tier.ts:
 * CHALLENGE_MARKERS, the `/cdn-cgi/challenge-platform/` path, `cf-turnstile`,
 * DataDome `_dd_s` / `id="cmsg"`) so this classifier never disagrees with the
 * shipped `isChallengeResponse` / `hasBrowserChallengeBody` about WHETHER a page
 * is a challenge — it only refines the SHAPE. Pure; fully unit-testable on HTML.
 */
export function classifyChallenge(html: string): ChallengeClass {
  if (!html) return 'none';
  // Challenge interstitials are tiny; bound every scan to the first 32KB to
  // match the shipped detectors and avoid full-document work on a real article.
  const slice = html.length > 32768 ? html.slice(0, 32768) : html;
  const lower = slice.toLowerCase();

  // A managed/invisible signal that is NOT itself a bare Cloudflare shell —
  // reCAPTCHA v3, DataDome, Akamai. These are POSITIVE evidence of a
  // no-widget/no-image challenge and out-rank a widget or image on ambiguity
  // (a v3 badge co-present with a stray image is not an image puzzle; a decoy
  // widget under a DataDome sensor is not solvable).
  const behavioralPositive = hasBehavioralPositiveMarker(lower);
  const image = hasImageMarker(lower, slice);
  const interactive = hasInteractiveMarker(lower, slice);

  // (1) A positive behavioral marker wins over everything — we must never claim
  //     an image/interactive solve on a managed/invisible challenge.
  if (behavioralPositive) return 'behavioral';
  // (2) Image outranks interactive — never downgrade a grid/text puzzle to a
  //     one-click checkbox.
  if (image) return 'image';
  // (3) A genuine clickable widget with no image and no behavioral marker.
  if (interactive) return 'interactive';
  // (4) A bare Cloudflare managed shell (skeleton / interstitial title) with no
  //     widget and no image → behavioral (managed check, nothing to click).
  if (isChallengeSkeleton(slice) || isCloudflareShell(lower)) return 'behavioral';
  return 'none';
}

// --- behavioral: managed / invisible, no clickable widget, no image ----------

/**
 * POSITIVE managed/invisible markers — vendor signals that are unambiguously a
 * no-widget/no-image challenge, so they out-rank a co-present widget or image
 * (the under-claim precedence). Deliberately EXCLUDES the bare Cloudflare
 * managed shell, which is handled as the final fallback in `classifyChallenge`
 * only after interactive/image are ruled out (so a Turnstile widget inside a
 * "Just a moment" shell classifies interactive, not behavioral).
 *   - reCAPTCHA v3: invisible-scoring badge (`grecaptcha-badge`) or
 *     `grecaptcha.execute` — no anchor checkbox.
 *   - DataDome: `_dd_s` sensor, `id="cmsg"` interstitial, `dd-loader`,
 *     `captcha-delivery.com` delivery host.
 *   - Akamai bot-manager: `/akam/…/sensor_data`, `bmak.` sensor, `_abck` cookie.
 */
function hasBehavioralPositiveMarker(lower: string): boolean {
  // reCAPTCHA v3 (invisible scoring).
  if (lower.includes('grecaptcha-badge')) return true;
  if (lower.includes('grecaptcha.execute')) return true;

  // DataDome — sensor / interstitial / delivery host.
  if (lower.includes('_dd_s')) return true;
  if (lower.includes('id="cmsg"')) return true;
  if (lower.includes('dd-loader')) return true;
  if (lower.includes('captcha-delivery.com')) return true;

  // Akamai bot-manager sensor.
  if (lower.includes('/akam/')) return true;
  if (lower.includes('bmak.')) return true;
  if (lower.includes('_abck')) return true;

  return false;
}

/**
 * A Cloudflare interstitial shell independent of the near-empty gate — the
 * classic legacy markers reused from the shipped CHALLENGE_MARKERS list. Kept
 * separate from `isChallengeSkeleton` so a managed shell with a slightly larger
 * body (still no real content) is still recognised.
 */
function isCloudflareShell(lower: string): boolean {
  return (
    lower.includes('cf-browser-verification') ||
    lower.includes('_cfchlopt') ||
    lower.includes('just a moment') ||
    lower.includes('attention required')
  );
}

// --- image: a visible-image puzzle to solve ----------------------------------

/**
 * Visible-image challenges (pixels to reason about, in-band vision-solvable):
 *   - reCAPTCHA image-select: the `api2/bframe` iframe (the grid frame; the
 *     `api2/anchor` checkbox is interactive, NOT image).
 *   - hCaptcha image grid: the `hcaptcha.com/.../challenge` iframe (its
 *     `/checkbox` iframe is interactive).
 *   - standalone text-captcha: an `<img>` whose src/alt implies a captcha
 *     co-present with a text `<input>` to type the answer.
 */
function hasImageMarker(lower: string, raw: string): boolean {
  if (lower.includes('api2/bframe')) return true;
  if (isHcaptchaChallengeFrame(lower)) return true;
  if (hasTextCaptcha(lower, raw)) return true;
  return false;
}

function isHcaptchaChallengeFrame(lower: string): boolean {
  // An hCaptcha iframe pointing at the image-grid endpoint. Match the specific
  // hCaptcha challenge path — NOT a bare `/challenge`, which also appears in
  // Cloudflare's `/cdn-cgi/challenge-platform/` script path. Require the
  // hcaptcha host AND the vendor challenge segment, and exclude the checkbox
  // endpoint so a checkbox iframe stays interactive.
  if (!lower.includes('hcaptcha.com')) return false;
  if (lower.includes('/captcha/v1/checkbox')) return false;
  return lower.includes('/captcha/v1/challenge');
}

/**
 * A standalone text-captcha: an image whose src or alt implies a captcha AND a
 * text input to type the answer into. Both are required — a lone decorative
 * image is not a puzzle, and a text input alone is just a form.
 */
function hasTextCaptcha(lower: string, raw: string): boolean {
  const captchaImg =
    /<img\b[^>]*(?:src|alt)\s*=\s*["'][^"']*captcha[^"']*["'][^>]*>/i.test(raw);
  const textInput =
    /<input\b[^>]*type\s*=\s*["']text["'][^>]*>/i.test(raw) ||
    // A name/id hint is enough when the type attribute is omitted.
    /<input\b[^>]*(?:name|id)\s*=\s*["'][^"']*captcha[^"']*["'][^>]*>/i.test(raw);
  return captchaImg && textInput && lower.includes('captcha');
}

// --- interactive: a clickable widget, no image -------------------------------

/**
 * Interactive (one clickable widget, no image to read):
 *   - Cloudflare Turnstile widget: `<div class="cf-turnstile">`, `#challenge-form`,
 *     or a `cf_chl_*` / `__cf_chl_*` script ref co-occurring with the widget.
 *   - reCAPTCHA checkbox: `#recaptcha-anchor`, `.recaptcha-checkbox`, or the
 *     `api2/anchor` iframe.
 *   - hCaptcha checkbox iframe: the `hcaptcha.com/.../checkbox` iframe.
 *
 * All widget markers are gated on a challenge-page skeleton so a REAL page that
 * merely embeds a widget (a login form with a live Turnstile) is not misread —
 * mirroring the shipped contextual-turnstile gate in `hasBrowserChallengeBody`.
 */
function hasInteractiveMarker(lower: string, raw: string): boolean {
  // hCaptcha checkbox iframe — host-scoped, so it never needs the skeleton gate
  // (a real page embedding hCaptcha still shows the checkbox as the challenge).
  if (lower.includes('hcaptcha.com') && lower.includes('/checkbox')) return true;

  // reCAPTCHA checkbox anchor — the anchor is the clickable checkbox.
  if (lower.includes('recaptcha-anchor')) return true;
  if (lower.includes('recaptcha-checkbox')) return true;
  if (lower.includes('api2/anchor')) return true;

  // Cloudflare Turnstile widget markers. `cf-turnstile` / `#challenge-form` /
  // the `cf_chl` script family can appear on real pages, so gate on a
  // challenge-page skeleton (matches the shipped contextual gate).
  const turnstileWidget =
    lower.includes('cf-turnstile') ||
    lower.includes('id="challenge-form"') ||
    lower.includes('cf_chl_') ||
    lower.includes('__cf_chl_');
  if (turnstileWidget && (isChallengeSkeleton(raw) || isCloudflareShell(lower))) {
    return true;
  }

  return false;
}
