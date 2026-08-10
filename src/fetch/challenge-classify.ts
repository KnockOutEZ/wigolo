import type { ChallengeClass } from '../types.js';
import type { ImageSolveSubType } from './ai-solve.js';
import { hasChallengeBody, isChallengeSkeleton, isNearEmptyBody } from './tls-tier.js';

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
 * Marker vocabulary is mostly REUSED from the shipped detector (tls-tier.ts:
 * CHALLENGE_MARKERS, `cf-turnstile`, DataDome `_dd_s` / `id="cmsg"`), so this
 * classifier largely tracks the shipped `isChallengeResponse` /
 * `hasBrowserChallengeBody` about WHETHER a page is a challenge, and refines the
 * SHAPE. Pure; fully unit-testable on HTML.
 *
 * IT IS NOT IDENTICAL TO THEM, IN BOTH DIRECTIONS. Stated because an earlier
 * version of this comment claimed it never disagrees, and that claim was false
 * at the time it was written:
 *
 *   - STRICTER on four vendor shapes the shared catalogue does not carry
 *     (`hasVendorTemplateMarker`: modern-CF interstitial, Imperva, Akamai, a
 *     lowercase Cloudflare phrase). It calls these challenges; a body-marker
 *     scan alone does not.
 *   - LOOSER wherever a STATUS is required, because this function never sees
 *     one. It cannot reach the status-gated general density rule, so a
 *     markerless wall it has no vocabulary for classifies 'none' here while
 *     `isChallengeShell(403, …)` fires.
 *
 * Consequence for callers: this is a SHAPE refiner for a challenge already
 * established. Using its 'none' as proof a body is safe to return is a category
 * error — see the clear-poll in `cdp-direct.ts`, which pairs it with the density
 * rule for exactly that reason.
 */
/** Visible-text length at or above which a body is REAL CONTENT and therefore
 *  cannot be an interstitial. Measured bot-wall pages carry 35-330 visible
 *  chars; an ordinary page carries thousands. */
const REAL_CONTENT_MIN_TEXT = 600;

/**
 * Titles that ONLY an interstitial ever carries. Unlike a vendor sensor script
 * (which rides along on pages served successfully), one of these in the <title>
 * is high-confidence proof the response IS the challenge — so it outranks the
 * content-length guard below. Some interstitials pad themselves with
 * explanatory copy, and a padded interstitial is still an interstitial.
 */
const INTERSTITIAL_TITLE =
  /<title>[^<]*(?:just a moment|attention required|checking your browser|access to this page has been denied|verifying you are human)[^<]*<\/title>/i;

/**
 * Vendor TEMPLATE markup — emitted only by the interstitial page itself, never by
 * a page served successfully. This is the load-bearing distinction: a vendor
 * SENSOR script (`_px*`, `_dd_s`, the reCAPTCHA badge) rides along on ordinary
 * pages, so content must outrank it; these template signatures do not, so they
 * outrank content. Verified: walmart.com's successfully-served page contains
 * NONE of these while carrying PerimeterX sensor markers throughout.
 */
const INTERSTITIAL_TEMPLATE_MARKERS = [
  'cf-browser-verification',
  '_cfChlOpt',
  'id="cmsg"',        // DataDome "enable JS" interstitial
  'id="px-captcha"',  // PerimeterX widget
  'px-captcha-error', // PerimeterX "denied" variant
  'Robot or human?',
] as const;

/** True when the body carries proof it IS an interstitial (title or template). */
function hasInterstitialSignal(slice: string, lower: string): boolean {
  if (INTERSTITIAL_TITLE.test(slice)) return true;
  return INTERSTITIAL_TEMPLATE_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

/** Approximate rendered-text length: drop script/style bodies, then tags. */
function visibleTextLength(html: string): number {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

export function classifyChallenge(html: string): ChallengeClass {
  if (!html) return 'none';
  // Challenge interstitials are tiny; bound every scan to the first 32KB to
  // match the shipped detectors and avoid full-document work on a real article.
  const slice = html.length > 32768 ? html.slice(0, 32768) : html;
  const lower = slice.toLowerCase();

  // CONTENT WINS OVER MARKERS.
  //
  // A site protected by PerimeterX / DataDome / reCAPTCHA embeds that vendor's
  // SENSOR script on every page it serves — including the ones it serves
  // SUCCESSFULLY. A marker therefore means "this vendor is present", NOT "this
  // request was blocked". Keying off markers alone misclassified real pages as
  // walls: walmart.com returned 405KB with the genuine title "Walmart | Save
  // Money. Live better." and 2,777 chars of visible text, yet classified
  // `behavioral` purely because its PerimeterX sensor markers were present
  // (measured 2026-07-28) — which rejects genuine content across a large slice
  // of the protected web.
  //
  // A body carrying real readable text IS a real page, whatever rides along in
  // it. Interstitials are uniformly tiny, so this cannot mask an actual wall.
  // Mirrors the HTTP-layer rule in tls-tier, which already requires markers AND
  // a thin body before calling a 2xx response a challenge.
  // Measured over the WHOLE document, deliberately NOT the 32KB marker slice: a
  // large real page's first 32KB is mostly <head> scripts/CSS and carries almost
  // no text (walmart's 405KB page has <600 visible chars in its first 32KB but
  // 2,777 overall), so slicing here would defeat the guard entirely.
  // The guard covers SENSOR markers only. An interstitial title or vendor
  // template signature is high-confidence proof the response IS the challenge,
  // and interstitials sometimes pad themselves with explanatory copy — a padded
  // interstitial is still an interstitial, so those outrank length.
  if (!hasInterstitialSignal(slice, lower) && visibleTextLength(html) >= REAL_CONTENT_MIN_TEXT) {
    return 'none';
  }

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
  // (4) A managed shell with no widget and no image → behavioral (managed check,
  //     nothing to click).
  //
  //     A LENGTH READING IS NEVER A VERDICT ON ITS OWN.
  //
  //     This arm used to be `isChallengeSkeleton(slice) || isCloudflareShell(lower)`.
  //     `isChallengeSkeleton`'s last arm is a bare `visibleText < 600`, and its
  //     own sibling docstring says it is "deliberately NOT sufficient on its own
  //     — callers pair it with an anti-bot STATUS". Used unpaired here, every
  //     page below the content floor carrying no vendor marker at all classified
  //     `behavioral`. Measured 2026-08-04: example.com, 559 bytes / ~128 visible
  //     chars at HTTP 200, an entirely legitimate page → `behavioral`.
  //
  //     That mattered most at the one call site that cannot supply a status by
  //     construction: `cdpDirectFetch` navigates and reads the DOM, then polls
  //     `classifyChallenge(html) === 'none'` as its clear-check. It therefore
  //     burned the full clear-poll budget and declined legitimate short pages as
  //     bot walls.
  //
  //     The pairing input a status-free caller CAN supply is the marker scan —
  //     which is exactly what the shipped HTTP-layer rule uses for a 2xx body
  //     (`isChallengeShell`: markers AND a skeleton, neither alone). cdp-direct
  //     synthesizes `statusCode: 200`, so the 2xx rule IS the status-free rule.
  //     Reusing it here keeps this classifier in agreement with the shipped
  //     detectors rather than inventing a second, weaker procedure.
  //
  //     Both halves are load-bearing in OPPOSITE directions, which is why
  //     neither a threshold tweak nor a marker list alone would do:
  //       - markers without the content check → an article ABOUT bot protection
  //         reads as a wall (the P0 defect in `isAntiBotSignal`);
  //       - the content check without markers → a legitimately tiny page reads
  //         as a wall (this defect).
  //     The 600 floor is unchanged; only its logical role is — from sufficient
  //     to necessary-but-not-sufficient.
  //
  //     `hasInterstitialSignal` stays a separate, higher-precedence arm: an
  //     interstitial title or vendor template signature is positive proof the
  //     response IS the challenge, so it outranks length in BOTH directions (a
  //     padded interstitial is still an interstitial).
  if (hasInterstitialSignal(slice, lower)) return 'behavioral';
  // The shipped 2xx rule, unchanged: catalogued marker + the skeleton reading.
  if (hasChallengeBody(slice) && isChallengeSkeleton(slice)) return 'behavioral';
  // Vendor markers the shared catalogue lacks, corroborated by a PURE TEXT-LENGTH
  // reading rather than `isChallengeSkeleton`.
  //
  // That distinction is the whole point and was got wrong once already.
  // `isChallengeSkeleton` SHORT-CIRCUITS TRUE on `/cdn-cgi/challenge-platform/`
  // (`tls-tier.ts:614`), which was one of the markers below — so pairing these
  // with it reduced to `marker && marker`, i.e. the marker ALONE. Structurally
  // the same vacuity as the `'slider'.includes('slide')` guard fixed elsewhere
  // in this file: a condition that corroborates itself.
  //
  // `tls-tier.ts` warns about exactly this, twice, for exactly that marker:
  // `:414-418` (it counts only alongside an anti-bot STATUS, so a 200 page
  // merely linking a `/cdn-cgi/` script can never trip it) and `:648-653`, where
  // `stillShowingChallenge` uses a text-length gate "deliberately NOT
  // isChallengeSkeleton, which short-circuits true on the marker itself".
  // `isNearEmptyBody` IS that text-length gate, so the corroboration is now
  // genuinely independent of the marker that triggered the check.
  //
  // NO REAL-FORM EXEMPTION HERE, DELIBERATELY.
  //
  // A previous revision ANDed `!hasRealForm(slice)` onto this arm to restore a
  // carve-out lost when the corroborator changed. That inverted the precedence
  // and FAILED OPEN: in `isChallengeSkeleton` the marker short-circuits FIRST
  // and the form exemption only guards the LENGTH arm, but ANDing it here let
  // the form outrank the vendor marker. A carve-out scoped to "is this thin body
  // a skeleton?" was promoted to "is this a challenge at all?".
  //
  // Measured cost: six real walls classified 'none' and were returned to the
  // agent as page content at a synthesized HTTP 200 — an Imperva wall with a
  // cookie banner, an Akamai denial with a search box, a Cloudflare wall with a
  // "Try again" button, and walls whose "form" was an input outside the element,
  // a commented-out block, or a JS string literal. Their bodies are under 1KB so
  // the density guard does not catch them either.
  //
  // ACCEPTED LIMITATION, stated because this IS a trade and not a free deletion.
  //
  // Stated GENERALLY rather than as one example, because the first version of
  // this note named only the login screen and a check for what the removal opens
  // immediately found three more. The general form: ANY of these markers
  // appearing as ordinary content on a body under the visible-text floor now
  // classifies `behavioral`. Measured instances:
  //   - a login screen whose submit status reads "Just a moment..."
  //   - a checkout form with an "Attention Required!" validation banner
  //   - an application 403 whose correlation id happens to be dot-separated hex
  //   - a short page naming the Imperva parameters in prose
  //   - a short page citing the FULL challenge-platform path, or naming
  //     `orchestrate/chl_page`, in prose (the Cloudflare parallel of the line
  //     above, which the first enumeration missed)
  // The fetch is not lost — it declines and falls back to the browser tier — but
  // it costs a rung.
  //
  // Taken deliberately: six ordinary wall shapes (a consent banner, a site
  // search box, a "go back" button, and forms that are not really forms) beat
  // one login page nobody has observed live. The direction matters more than the
  // count — the six FAIL OPEN, handing an interstitial to the agent as page
  // content, while this one fails CLOSED.
  //
  // If that login shape is ever observed live, the right repair is to RESCOPE
  // the exemption to the length question rather than reinstate it here as a veto
  // over a positive marker. This comment is where to look.
  //
  // Note the Imperva login page that originally motivated the exemption is
  // released by the MARKER NARROWING instead — its resource path is a rider, not
  // a template. Verified by measurement before removing.
  //
  // TRANSFERABLE, and the inverse of the mistake that introduced it: that change
  // inherited what the new predicate LACKED; this one inherited what it PERMITS.
  // A loose predicate is harmless while it merely SUPPRESSES a heuristic and
  // becomes dangerous the moment it can VETO a positive match. Promoting a
  // predicate to a stronger position inherits its looseness at the new strength.
  if (hasVendorTemplateMarker(lower) && isNearEmptyBody(slice)) return 'behavioral';
  return 'none';
}

/**
 * Vendor template markers that the SHARED `CHALLENGE_MARKERS` catalogue does not
 * carry. Paired with the skeleton reading by the caller — never used alone.
 *
 * WHY THIS EXISTS. The arm this replaced was
 * `isChallengeSkeleton(slice) || isCloudflareShell(lower)`. Only ONE thing in it
 * was defective: `isChallengeSkeleton`'s final `visibleText < 600` arm. But that
 * predicate ALSO short-circuits true on two positive MARKERS (the
 * `/cdn-cgi/challenge-platform/` script path and the interstitial title), and
 * `isCloudflareShell` is a pure marker check. Removing the whole expression to
 * kill the length heuristic removed the markers with it — so vendors absent from
 * the shared catalogue lost their coverage silently, and a base-vs-tip
 * differential showed four wall shapes flipping `behavioral` -> `none`:
 * a modern-CF skeleton, an Imperva/Incapsula stub, an Akamai denial, and a
 * lowercase Cloudflare body phrase.
 *
 * Matching is on the LOWERCASED slice. The shared `hasChallengeBody` compares
 * case-SENSITIVELY against raw HTML while the removed `isCloudflareShell`
 * compared on `lower`, so a lowercase `just a moment` body variant was released.
 *
 * These are PAIRED with the skeleton reading rather than treated as unconditional
 * proof, deliberately. `tls-tier.ts` already documents the reason for the
 * challenge-platform path specifically: a real full article that merely
 * references the script path must NOT read as a challenge. Pairing keeps that
 * true, and the content guard above releases anything with real prose first.
 */
function hasVendorTemplateMarker(lower: string): boolean {
  // Cloudflare shell phrasing — case-insensitive, unlike the shared catalogue.
  if (lower.includes('cf-browser-verification')) return true;
  if (lower.includes('_cfchlopt')) return true;
  if (lower.includes('just a moment')) return true;
  // The WAF block page's title is "Attention Required! | Cloudflare". The bang is
  // required: bare "attention required" is ordinary UI copy on form errors.
  if (lower.includes('attention required!')) return true;
  // Modern Cloudflare — the INTERSTITIAL's orchestration script only.
  //
  // Deliberately NOT the bare `/cdn-cgi/challenge-platform/` prefix. Cloudflare
  // JS Detections injects `/cdn-cgi/challenge-platform/scripts/jsd/main.js` into
  // pages it serves SUCCESSFULLY, so the prefix is a "this zone uses Cloudflare"
  // signal, not "this response is a challenge" — the same sensor-vs-template
  // distinction this module already documents for PerimeterX and DataDome.
  //
  // Measured on the prefix: a 193-byte thin SPA shell, a 157-byte landing page
  // and an 80-byte page citing the path in CSP prose all classified behavioral.
  // Through `cdpDirectFetch` that is precisely the defect this slice exists to
  // fix — a legitimate short page burning the clear-poll and declining — merely
  // narrowed from all thin pages to Cloudflare-protected thin pages.
  //
  // `orchestrate/chl_` appears in the interstitial's own script path
  // (`…/h/g/orchestrate/chl_page/v1`) and in neither the JSD sensor path nor a
  // prose citation of the prefix.
  if (lower.includes('orchestrate/chl_')) return true;
  // Imperva / Incapsula — the INTERSTITIAL's resource call only.
  //
  // Deliberately NOT the bare `_incapsula_resource` path. Imperva injects that
  // same endpoint into pages it serves SUCCESSFULLY (e.g.
  // `?SWJIYLWA=<hash>`), so the bare path is a rider, not a template — the
  // identical sensor-vs-template distinction already applied to Cloudflare's JSD
  // path a few lines up, which this entry was left behind by.
  //
  // The interstitial's own call carries the `CWUDNSAI` / `SWUDNSAI` parameters.
  if (lower.includes('cwudnsai') || lower.includes('swudnsai')) return true;
  // Akamai denial template: the phrase AND a reference id in Akamai's own shape
  // (dot-separated hex groups, e.g. `18.1a2b3c4d.1712345678.9abcdef`).
  //
  // The literal phrase pair was too weak. "Access Denied" is ordinary 403 copy
  // and a bare "Reference #" is ordinary support copy, so a 99-byte help snippet
  // ("If you see Access Denied, quote the Reference # shown on the page") and a
  // genuine app 403 carrying `Reference #4821` both classified behavioral.
  // Requiring the id's STRUCTURE keeps the real template and releases both.
  if (lower.includes('access denied') && hasAkamaiReferenceId(lower)) return true;
  return false;
}

/**
 * The long-group test runs on the MATCHED id, never on the whole body — an
 * unrelated long hex string elsewhere on the page (an asset hash, a nonce) must
 * not license a short dotted section number.
 */
function hasAkamaiReferenceId(lower: string): boolean {
  const m = AKAMAI_REFERENCE_ID.exec(lower);
  return m !== null && AKAMAI_REFERENCE_LONG_GROUP.test(m[0]);
}

/**
 * Akamai's error reference id: `#` then 3+ dot-separated hex groups, AT LEAST
 * ONE of which is 6+ characters.
 *
 * The length requirement is what separates the id from a dotted SECTION NUMBER.
 * Without it, `reference #1.2.3 of the policy` on a 126-byte page satisfied the
 * pattern and classified behavioral — the same over-fire as the literal phrase
 * pair it replaced, one refinement further in. Real ids carry long hex groups
 * (`18.1a2b3c4d.1712345678.9abcdef`); section numbers never do.
 */
const AKAMAI_REFERENCE_ID =
  /reference\s*#\s*[0-9a-f]+(?:\.[0-9a-f]+){2,}/i;
const AKAMAI_REFERENCE_LONG_GROUP = /[0-9a-f]{6,}/i;

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

/**
 * Refine an 'image'-class challenge into the concrete solver sub-type the
 * ai-vision rung should drive. Pure; conservative — DEFAULTS to 'grid' (the
 * common reCAPTCHA / hCaptcha image-select, and the safe majority case) on any
 * ambiguity so we never mis-drive a grid solve as a slider drag / text type.
 *
 * Precedence:
 *   1. slider  — a drag-puzzle (GeeTest `slideBg` / `slider` / a `drag` puzzle
 *      marker). Wins over a co-present text-captcha (a slide puzzle can carry a
 *      decorative captcha image + input).
 *   2. grid    — a reCAPTCHA `api2/bframe` / hCaptcha challenge-grid frame. Wins
 *      over a bare text-captcha for the same reason.
 *   3. text    — a captcha `<img>` + a text `<input>` and NO grid / slider.
 *   4. grid    — default (reCAPTCHA / hCaptcha common case; ambiguity-safe).
 *
 * Marker vocabulary is reused from this module's image detectors (`hasImageMarker`
 * / `hasTextCaptcha`) so the sub-type never disagrees with the 'image' class.
 */
export function classifyImageSubType(html: string): ImageSolveSubType {
  if (!html) return 'grid';
  const slice = html.length > 32768 ? html.slice(0, 32768) : html;
  const lower = slice.toLowerCase();

  // (1) A drag-puzzle marker → slider (out-ranks a co-present text-captcha).
  if (hasSliderMarker(lower)) return 'slider';
  // (2) A reCAPTCHA/hCaptcha image-grid frame → grid (the common case).
  if (hasGridMarker(lower)) return 'grid';
  // (3) A standalone text-captcha (img + text input) and nothing grid/slider.
  if (hasTextCaptcha(lower, slice)) return 'text';
  // (4) Ambiguity-safe default.
  return 'grid';
}

/**
 * A drag/slide puzzle: GeeTest slide-puzzle markers (`geetest_slider`,
 * `slidebg`), a generic `slidebg` / `slider` element, or an explicit drag-to-
 * complete puzzle hint. Kept conservative — a lone `slider` token would be too
 * broad (a range input, a carousel), so require a puzzle-shaped signal: GeeTest,
 * a `slidebg` background image, or a `slider`/`drag` marker co-present with a
 * puzzle/verify hint.
 */
function hasSliderMarker(lower: string): boolean {
  if (lower.includes('geetest')) return true;
  if (lower.includes('slidebg')) return true;
  // The corroborating hint must be a SEPARATE signal from the token that
  // triggered the check. `'slider'.includes('slide')` made the old guard
  // vacuous: every carousel, range input and `class="slider"` satisfied its own
  // corroboration and classified as a drag puzzle, so the vision rung would
  // attempt a drag on ordinary UI.
  const sliderish = lower.includes('slider') || lower.includes('drag');
  if (!sliderish) return false;
  return lower.includes('puzzle') || lower.includes('verify') || lower.includes('captcha');
}

/**
 * A reCAPTCHA / hCaptcha image-grid frame — the common image-select puzzle. The
 * grid markers from `hasImageMarker` (the `api2/bframe` iframe, the hCaptcha
 * `/captcha/v1/challenge` frame), EXCLUDING the standalone text-captcha shape
 * (that is the `text` sub-type, not a grid).
 */
function hasGridMarker(lower: string): boolean {
  if (lower.includes('api2/bframe')) return true;
  if (isHcaptchaChallengeFrame(lower)) return true;
  return false;
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
