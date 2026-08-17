import { describe, it, expect, vi } from 'vitest';
import { runStudioFetch, type StudioFetchDeps } from '../../../src/studio/studio-fetch.js';
import type { SessionDrive, StudioSessionsAccessor } from '../../../src/studio/session-drive.js';
import { isChallengeShell } from '../../../src/fetch/tls-tier.js';
import { classifyChallenge } from '../../../src/fetch/challenge-classify.js';

/**
 * S9 slice 1 — the BROKER `studio_fetch` capability.
 *
 * This is NOT an MCP tool: it is the host-side capability the core's SmartRouter escalation rung reaches
 * over the already-authenticated gateway transport. Its whole reason to exist is that a bot-walled page
 * can be served off the human's real, attended browser instead of a headless pool — so the tests below
 * encode the three things that make that legitimate: the navigation is GATED (never a looser lane than
 * studio_act), a login page is REFUSED before its bytes are read, and an absent/dead session is an
 * explicit error rather than a silent downgrade.
 */

function drive(over: Partial<SessionDrive> = {}): SessionDrive {
  return {
    currentUrl: () => 'https://example.com/',
    gatedNavigate: vi.fn(async () => ({ ok: true as const })),
    readCurrentPage: vi.fn(async () => ({ url: 'https://example.com/', html: '<html><body>real</body></html>' })),
    insertTrusted0: vi.fn(async () => ({ artifactId: 1, inserted: true, contentHash: 'h' }) as never),
    isCredentialContext: vi.fn(async () => false),
    ...over,
  };
}

function deps(over: Partial<StudioFetchDeps> = {}): StudioFetchDeps {
  const d = drive();
  const sessions: StudioSessionsAccessor = { getSessionDrive: (id) => (id === 's1' ? d : undefined) };
  return {
    sessions,
    host: {
      list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }),
      spawn: async () => ({ session_id: 's1' }),
    },
    ...over,
  };
}

describe('runStudioFetch — resolving a session', () => {
  it('drives the live session the host already has, without spawning a second one', async () => {
    const spawn = vi.fn(async () => ({ session_id: 'never' }));
    const d = deps({ host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn } });
    const r = await runStudioFetch(d, { url: 'https://example.com/' });
    expect(r.ok).toBe(true);
    // Spawning when a usable session exists would open a second window in the human's face for every
    // escalated fetch — the bridge is meant to be invisible, not to litter the desktop.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns a background session when the host has none, and drives that one', async () => {
    const fresh = drive();
    const spawn = vi.fn(async () => ({ session_id: 'new1' }));
    const d = deps({
      sessions: { getSessionDrive: (id) => (id === 'new1' ? fresh : undefined) },
      host: { list: async () => ({ sessions: [] }), spawn },
    });
    const r = await runStudioFetch(d, { url: 'https://example.com/' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, session_id: 'new1' });
  });

  it('skips a listed session whose drive is gone rather than failing on it', async () => {
    const live = drive();
    const d = deps({
      sessions: { getSessionDrive: (id) => (id === 'good' ? live : undefined) },
      host: {
        list: async () => ({ sessions: [
          { id: 'stale', status: 'closed', clients: 0, createdAt: 0, lastActiveAt: 0 },
          { id: 'good', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 },
        ] }),
        spawn: async () => ({ session_id: 'unused' }),
      },
    });
    const r = await runStudioFetch(d, { url: 'https://example.com/' });
    expect(r).toMatchObject({ ok: true, session_id: 'good' });
  });

  it('errors explicitly when no drive can be obtained — never returns empty content as if the page were blank', async () => {
    const d = deps({
      sessions: { getSessionDrive: () => undefined },
      host: { list: async () => ({ sessions: [] }), spawn: async () => ({ session_id: 'nope' }) },
    });
    const r = await runStudioFetch(d, { url: 'https://example.com/' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('studio_no_drive');
  });

  it('surfaces a spawn refusal as an error instead of pretending there is a session', async () => {
    const d = deps({
      sessions: { getSessionDrive: () => undefined },
      host: {
        list: async () => ({ sessions: [] }),
        spawn: async () => ({ error_reason: 'session cap reached', hint: 'close one' }),
      },
    });
    const r = await runStudioFetch(d, { url: 'https://example.com/' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('studio_no_drive');
  });
});

describe('runStudioFetch — the gated navigation lane', () => {
  it('navigates through gatedNavigate, so the SSRF fence and control token apply to the bridge too', async () => {
    const gatedNavigate = vi.fn(async () => ({ ok: true as const }));
    const d = drive({ gatedNavigate });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'https://example.com/x' },
    );
    expect(gatedNavigate).toHaveBeenCalledWith('https://example.com/x');
    expect(r.ok).toBe(true);
  });

  it('maps a blocked navigation to navigation_blocked and reads nothing', async () => {
    const readCurrentPage = vi.fn(async () => ({ url: '', html: '' }));
    const d = drive({ gatedNavigate: async () => ({ ok: false, reason: 'navigation_blocked' }), readCurrentPage });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'http://169.254.169.254/latest/meta-data/' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('navigation_blocked');
    // A refused navigation must not be followed by a page read: the tab is still showing whatever the
    // human had open, and returning THAT to the agent is the disclosure the fence exists to prevent.
    expect(readCurrentPage).not.toHaveBeenCalled();
  });

  it('maps a human reclaim to not_holder — the bridge never drives over the human', async () => {
    const d = drive({ gatedNavigate: async () => ({ ok: false, reason: 'not_holder', currentEpoch: 7 }) });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'https://example.com/' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_holder');
  });
});

describe('runStudioFetch — the credential-context refusal', () => {
  it('refuses a login page BEFORE reading its html', async () => {
    const readCurrentPage = vi.fn(async () => ({ url: 'https://example.com/login', html: '<input type=password>' }));
    const d = drive({ isCredentialContext: async () => true, readCurrentPage });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'https://example.com/login' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('capture_refused');
    // Ordering is the point: a login page's html can contain a displayed one-time code or a prefilled
    // identifier. Reading it and then discarding it still put it in this process's memory and any log.
    expect(readCurrentPage).not.toHaveBeenCalled();
  });

  it('refuses when the credential probe itself throws — fail-closed, never "probe broke, assume safe"', async () => {
    const readCurrentPage = vi.fn(async () => ({ url: 'https://example.com/', html: '<html>x</html>' }));
    const d = drive({ isCredentialContext: async () => { throw new Error('cdp gone'); }, readCurrentPage });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'https://example.com/' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('capture_refused');
    expect(readCurrentPage).not.toHaveBeenCalled();
  });
});

describe('runStudioFetch — input validation', () => {
  it('refuses a missing/blank url without touching the session', async () => {
    const gatedNavigate = vi.fn(async () => ({ ok: true as const }));
    const d = drive({ gatedNavigate });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: '  ' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_url');
    expect(gatedNavigate).not.toHaveBeenCalled();
  });

  it('returns the live post-redirect url and the page html on success', async () => {
    const d = drive({ readCurrentPage: async () => ({ url: 'https://example.com/final', html: '<html>ok</html>' }) });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'https://example.com/' },
    );
    expect(r).toEqual({ ok: true, url: 'https://example.com/final', html: '<html>ok</html>', session_id: 's1' });
  });
});

/**
 * S9B slice 1 — the bridge must not hand a CHALLENGE SHELL to core as content.
 *
 * WHY this matters more than it looks: the rung that calls this capability fires only AFTER the browser
 * tier has terminally hit a challenge (`router.ts:785,803`), and the router returns the bridge's result
 * DIRECTLY — unlike the browser tier's own result, which is wrapped in `guardChallengeShell`
 * (`router.ts:779`). So an unguarded shell here does not merely produce a thin page: it converts an
 * honest `blocked_by_challenge` into a SUCCESSFUL fetch whose body is an interstitial, which then gets
 * extracted, cached, and cited as if it were the page. That is the `challenge-shell-as-content` failure
 * class already on record in the P0 long-tail, reached by a new path.
 *
 * Classification happens HERE rather than only in the router because this is the one place that knows
 * the bytes are raw page HTML from a real browser, which is the only input `classifyChallenge` is valid
 * on.
 */
describe('runStudioFetch — a challenge shell is never returned as content', () => {
  // A 2xx Cloudflare interstitial: a challenge marker plus the thin all-scaffolding shape. This is what
  // the substrate reads when the human's browser is ALSO walled.
  const CF_SHELL =
    '<html><head><title>Just a moment...</title></head><body>' +
    '<div id="cf-wrapper"><div class="cf-browser-verification"></div></div>' +
    '<script>window._cfChlOpt={cvId:"3"};</script></body></html>';

  it('refuses a Cloudflare interstitial instead of reporting it as a successful page', async () => {
    const d = drive({ readCurrentPage: async () => ({ url: 'https://walled.example/', html: CF_SHELL }) });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'https://walled.example/' },
    );
    expect(r.ok).toBe(false);
    // `blocked_by_challenge` deliberately: the agent already handles that path (S9 §5.1), so the caller
    // keeps its honest block instead of learning a new reason code.
    if (!r.ok) expect(r.error).toBe('blocked_by_challenge');
  });

  it('reports the challenge CLASS, so a caller can tell a solvable wall from a behavioral one', async () => {
    const d = drive({ readCurrentPage: async () => ({ url: 'https://walled.example/', html: CF_SHELL }) });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'https://walled.example/' },
    );
    expect(r.ok).toBe(false);
    // The class is what decides whether a human could help at all: `behavioral` runs no solve rung
    // (`solve-ladder.ts:95-97`), so surfacing it is what keeps S9B from promising a click that cannot exist.
    if (!r.ok) expect(typeof r.challenge_class).toBe('string');
  });

  it('lets a REAL page through untouched — the guard must not eat ordinary content', async () => {
    // The regression that matters in the other direction. A page from a site that merely EMBEDS an
    // anti-bot sensor is not a blocked page, and `classifyChallenge` is written content-wins-over-markers
    // for exactly that reason. A guard that cannot tell them apart would break every protected site the
    // bridge successfully opens — which is the bridge's entire purpose.
    const real =
      '<html><head><title>Real Article</title></head><body>' +
      `<article>${'Substantive readable prose about a real subject. '.repeat(60)}</article>` +
      '<script src="/dd-loader.js"></script></body></html>';
    const d = drive({ readCurrentPage: async () => ({ url: 'https://ok.example/a', html: real }) });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'https://ok.example/a' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).toBe(real);
  });

  it('classifies AFTER the credential gate, so a login page is still refused as a credential context', async () => {
    // Ordering assertion, not a style preference: a login page can carry challenge markers too, and if
    // classification ran first it would be reported as a wall — losing the credential refusal that is the
    // stronger and more specific protection.
    const d = drive({
      isCredentialContext: async () => true,
      readCurrentPage: vi.fn(async () => ({ url: 'https://login.example/', html: CF_SHELL })),
    });
    const r = await runStudioFetch(
      { sessions: { getSessionDrive: () => d }, host: { list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }), spawn: async () => ({ session_id: 's1' }) } },
      { url: 'https://login.example/' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('capture_refused');
    // And the page was never read at all — the credential gate runs BEFORE the read (S9 step 5).
    expect(d.readCurrentPage).not.toHaveBeenCalled();
  });
});

/**
 * S9B slice 1 — WHY the gate is `isChallengeShell` and not `classifyChallenge`.
 *
 * `studio-fetch.ts` carries a comment claiming that gating on `classifyChallenge(html) !== 'none'`
 * would refuse real pages. A claim written into source and never executed is not a justification, so
 * these tests EXECUTE it: they assert the two predicates DISAGREE on the inputs that matter, in the
 * direction the choice depends on.
 *
 * This is deliberately a permanent test rather than a one-off mutation of the guard. A mutation proves
 * the tests had teeth on the day it ran; this reds if anyone later swaps the predicate — which is the
 * regression actually worth catching.
 */
describe('S9B slice 1 — the gate predicate choice is justified by measurement, not by comment', () => {
  const CF_SHELL =
    '<html><head><title>Just a moment...</title></head><body>' +
    '<div id="cf-wrapper"><div class="cf-browser-verification"></div></div>' +
    '<script>window._cfChlOpt={cvId:"3"};</script></body></html>';

  // A real article from a site that merely EMBEDS an anti-bot sensor. Protected sites serve their
  // sensor on pages they serve SUCCESSFULLY, which is the whole reason a marker is not a verdict.
  const REAL_WITH_SENSOR =
    '<html><head><title>Real Article</title></head><body>' +
    `<article>${'Substantive readable prose about a real subject. '.repeat(60)}</article>` +
    '<script src="/dd-loader.js"></script></body></html>';

  // A genuine page that is simply THIN. The d14 spike measured `classifyChallenge` calling
  // example.com 'behavioral'; slice P3-CLASSIFY fixed that (it was a length reading used as a
  // verdict), so this input now agrees across both predicates. Kept as a regression fixture: the
  // gate must never call it a shell again, from either predicate.
  const THIN_BUT_REAL =
    '<html><head><title>Example Domain</title></head><body><div><h1>Example Domain</h1>' +
    '<p>This domain is for use in illustrative examples in documents.</p></div></body></html>';

  // A NOVEL vendor's wall: a large all-scaffolding body carrying NONE of the catalogued challenge
  // markers. Only the GENERAL density rule catches this shape — and that rule is STATUS-GATED,
  // which is the point of the test below.
  //
  // It carries essentially NO visible text, which is now load-bearing in a way it was not before.
  // A previous revision of this fixture was deliberately PADDED past 600 visible chars, to make its
  // `classifyChallenge` verdict of 'none' hold at base `fb16fb01` as well as at tip. That padding no
  // longer describes a wall the shipped rules catch: the wall-shape rule now requires the body to be
  // below the interstitial content floor ABSOLUTELY, because the ratio alone called ordinary
  // JS-heavy pages (github, walmart, bbc) walls. A padded markerless wall escapes both arms — the
  // honest ceiling of a shape heuristic, recorded in `isLowContentDensity`'s docstring, not
  // something to encode here as if it were caught.
  //
  // So the fixture is a markerless wall with no readable content, and the pair below is asserted as
  // a TIP property: at tip, `isChallengeShell(403, …)` fires on it and the status-free
  // `classifyChallenge` returns 'none'. That is the whole claim the gate choice rests on.
  const MARKERLESS_WALL =
    '<html><head><title>Security Check</title>' +
    '<script>' + 'var _z=[];for(var i=0;i<64;i++){_z.push((i*31)%97);}'.repeat(700) + '</script>' +
    '</head><body><div id="sec-check"></div></body></html>';

  it('fires on a real interstitial — the shell is caught', () => {
    expect(isChallengeShell(200, CF_SHELL)).toBe(true);
  });

  it('does NOT fire on a real page carrying an anti-bot sensor', () => {
    expect(isChallengeShell(200, REAL_WITH_SENSOR)).toBe(false);
  });

  it('does NOT fire on a thin-but-genuine page', () => {
    expect(isChallengeShell(200, THIN_BUT_REAL)).toBe(false);
  });

  it('classifyChallenge is UNSAFE as the gate because it is STATUS-FREE — it MISSES a markerless wall', () => {
    // The justification, restated after slice P3-CLASSIFY.
    //
    // The original version rested on `classifyChallenge` OVER-firing: it called a thin-but-genuine
    // page 'behavioral' because its skeleton predicate read visible-text length as a verdict. That
    // was a defect, and it has been fixed — so that assertion would now be asserting a bug.
    //
    // The gate choice survives on a stronger and opposite ground, and this pair is the evidence:
    // `classifyChallenge` takes HTML only, so it cannot reach the STATUS-GATED general density rule,
    // which is the one rule that catches a wall from a vendor whose markers are not catalogued. As a
    // gate it would UNDER-fire and hand a real wall back as content — the failure a gate exists to
    // prevent, and the worse direction of the two.
    //
    // Asserted as a TIP property (see the fixture comment): the wall-shape rule reads the content
    // floor absolutely now, so a wall padded past that floor to satisfy an older base-differential
    // is no longer a wall either predicate catches, and pinning one here would pin a miss.
    expect(isChallengeShell(403, MARKERLESS_WALL)).toBe(true);
    expect(classifyChallenge(MARKERLESS_WALL)).toBe('none');

    // The sensor-bearing article: 'none' at both revisions — content wins over markers, as designed.
    expect(classifyChallenge(REAL_WITH_SENSOR)).toBe('none');

    // The thin genuine page: 'none' is NEW as of P3-CLASSIFY (it was 'behavioral' at base). Asserted
    // as the fix it is, and labelled as such rather than presented as a standing property.
    expect(classifyChallenge(THIN_BUT_REAL)).toBe('none');
  });

  it('the class attached to a caught shell is the CLASSIFIER\'s, and it can be a class no solve rung serves', () => {
    // Consequence worth encoding rather than discovering later: a Cloudflare interstitial with no
    // interactive widget classifies `behavioral`, and `solve-ladder.ts:95–97` runs NO rung for that class.
    // So catching a shell does not imply a human could clear it — which is precisely why the refusal
    // carries the class instead of implying solvability.
    expect(classifyChallenge(CF_SHELL)).toBe('behavioral');
  });
});
