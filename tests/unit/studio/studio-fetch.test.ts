import { describe, it, expect, vi } from 'vitest';
import { runStudioFetch, type StudioFetchDeps } from '../../../src/studio/studio-fetch.js';
import type { SessionDrive, StudioSessionsAccessor } from '../../../src/studio/session-drive.js';

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
