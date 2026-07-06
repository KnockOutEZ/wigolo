import { describe, it, expect, vi } from 'vitest';
import type { DebuggerLike } from '../../src/main/cdp-transport';
import { createDriveEngine } from '../../src/main/drive-engine';
import { createStudioHost, stageForActResult, type HostTab, type ParkedApprovalNotice } from '../../src/main/studio-host';
import type { StudioActOutput, StudioToolError } from 'wigolo/studio';

/** A fake webContents.debugger answering the CDP calls observe/act/nav make on an empty page. */
function fakeDebugger(): DebuggerLike {
  let attached = false;
  let onMsg: ((e: unknown, method: string, params: unknown) => void) | null = null;
  return {
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    isAttached: () => attached,
    sendCommand: async (method: string) => {
      switch (method) {
        case 'Accessibility.getFullAXTree': return { nodes: [] };
        case 'DOM.getDocument': return { root: { nodeName: '#document', backendNodeId: 1, children: [] } };
        case 'Page.getLayoutMetrics': return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        default: return {};
      }
    },
    on: (_e, cb) => { onMsg = cb as typeof onMsg; },
    removeListener: () => { onMsg = null; },
  };
}

const viewport = () => ({ width: 800, height: 600 });

/** Build a host wired to fake driven tabs; returns the host plus the parked-approval sink + navigate spies. */
function makeHost(config?: { sessionCap?: number }) {
  const engine = createDriveEngine();
  const parked: ParkedApprovalNotice[] = [];
  const tabs = new Map<string, { navigate: ReturnType<typeof vi.fn>; closed: boolean; url: string }>();
  let n = 0;
  const host = createStudioHost({
    config,
    onParked: (notice) => parked.push(notice),
    createTab: ({ initialHolder, grant, startUrl }) => {
      const tabId = `t${++n}`;
      const drive = engine.attachTab(tabId, { debugger: fakeDebugger(), viewport, grant, initialHolder });
      const state = { navigate: vi.fn(async (u: string) => { state.url = u; }), closed: false, url: startUrl ?? 'about:blank' };
      tabs.set(tabId, state);
      const tab: HostTab = {
        tabId,
        drive,
        browser: { navigate: (u) => state.navigate(u) },
        currentUrl: () => state.url,
        readHtml: async () => '<html></html>',
      };
      return tab;
    },
    closeTab: (tabId) => { const t = tabs.get(tabId); if (t) t.closed = true; void engine.detachTab(tabId); },
  });
  return { host, parked, tabs };
}

describe('createStudioHost — session lifecycle', () => {
  it('studio_open creates an agent-controlled session and returns its id', async () => {
    const { host } = makeHost();
    const r = await host.handlers.spawn({ startUrl: 'https://example.com/' });
    expect('session_id' in r).toBe(true);
    const id = (r as { session_id: string }).session_id;
    // The agent holds control of its own opened session (background-lane rule).
    expect(host.sessions.getSessionDrive(id)).toBeTruthy();
  });

  it('enforces the per-host session cap with an explicit refusal (never a silent failure)', async () => {
    const { host } = makeHost({ sessionCap: 1 });
    await host.handlers.spawn({});
    const second = await host.handlers.spawn({});
    expect((second as StudioToolError).error_reason).toBe('studio_session_limit');
  });

  it('list reflects live sessions; close removes one and getSessionDrive then returns undefined', async () => {
    const { host } = makeHost();
    const opened = await host.handlers.spawn({}) as { session_id: string };
    const listed = await host.handlers.list();
    expect('sessions' in listed && listed.sessions.some((s) => s.id === opened.session_id)).toBe(true);
    const closed = await host.handlers.close({ session_id: opened.session_id });
    expect((closed as { closed?: boolean }).closed).toBe(true);
    expect(host.sessions.getSessionDrive(opened.session_id)).toBeUndefined();
  });

  it('close of an unknown session is an explicit refusal', async () => {
    const { host } = makeHost();
    const r = await host.handlers.close({ session_id: 'nope' });
    expect((r as StudioToolError).error_reason).toBe('no_such_session');
  });
});

describe('createStudioHost — observe fences page content as untrusted', () => {
  it('studio_observe returns trusted:false + the untrusted-data notice (page perception is data, not instructions)', async () => {
    const { host } = makeHost();
    await host.handlers.spawn({});
    const r = await host.handlers.observe({});
    expect('trusted' in r && r.trusted).toBe(false);
    expect('untrusted_notice' in r && typeof r.untrusted_notice === 'string' && r.untrusted_notice.length > 0).toBe(true);
  });

  it('observe with no open session is an explicit refusal, not an empty result', async () => {
    const { host } = makeHost();
    const r = await host.handlers.observe({});
    expect((r as StudioToolError).error_reason).toBe('no_active_session');
  });
});

describe('createStudioHost — D19 session-drive accessor SSRF contract', () => {
  it('gatedNavigate blocks cloud-metadata for the agent (never reachable) and allows a public URL', async () => {
    const { host, tabs } = makeHost();
    const opened = await host.handlers.spawn({}) as { session_id: string };
    const drive = host.sessions.getSessionDrive(opened.session_id)!;
    const blocked = await drive.gatedNavigate('http://169.254.169.254/latest/meta-data');
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.reason).toBe('navigation_blocked');
    const ok = await drive.gatedNavigate('https://example.com/');
    expect(ok.ok).toBe(true);
    // the public nav reached the tab; the blocked one never did
    expect([...tabs.values()][0].navigate).toHaveBeenCalledWith('https://example.com/');
    expect([...tabs.values()][0].navigate).not.toHaveBeenCalledWith('http://169.254.169.254/latest/meta-data');
  });
});

describe('createStudioHost — native input preempts the agent', () => {
  it('onHumanInput flips the driven tab to paused (the in-flight act is fenced)', async () => {
    const { host } = makeHost();
    const opened = await host.handlers.spawn({}) as { session_id: string };
    const drive = host.sessions.getSessionDrive(opened.session_id)!;
    expect(drive.currentUrl).toBeTypeOf('function');
    // agent holds its own session; a native human touch preempts instantly.
    host.onHumanInput('t1');
    // The FSM is internal to the drive engine; assert via a second navigate now being non-holder-gated.
    const r = await drive.gatedNavigate('https://example.com/');
    expect(r.ok).toBe(false); // human holds now → agent nav refused
    expect(r.ok === false && r.reason).toBe('not_holder');
  });

  it('resolveApproval on an unknown id is a safe no-op', () => {
    const { host } = makeHost();
    expect(() => host.resolveApproval('unknown', 'allow')).not.toThrow();
  });
});

describe('stageForActResult — pure P1 stage discriminant', () => {
  const ok: StudioActOutput = { ok: true, action: 'click' };
  it('a parked risky act with an approval id becomes a non-error pending_approval stage', () => {
    const r = stageForActResult({ error_reason: 'parked_for_review', hint: 'x' }, 'click', 'ap-1');
    expect(r).toEqual({ ok: true, action: 'click', stage: 'pending_approval', approval_id: 'ap-1' });
  });
  it('a reclaim-during-act becomes a preempted stage, carrying charsLanded when present', () => {
    const r = stageForActResult({ error_reason: 'aborted_reclaimed', hint: 'x', charsLanded: 3 }, 'type', undefined);
    expect(r).toEqual({ ok: true, action: 'type', stage: 'preempted', charsLanded: 3 });
  });
  it('a parked error WITHOUT an approval id passes through as the raw error (fail-loud, no fake stage)', () => {
    const err: StudioToolError = { error_reason: 'parked_for_review', hint: 'x' };
    expect(stageForActResult(err, 'click', undefined)).toBe(err);
  });
  it('other errors and successes pass through untouched', () => {
    const err: StudioToolError = { error_reason: 'not_holder', hint: 'x', currentEpoch: 2 };
    expect(stageForActResult(err, 'click', 'ap-1')).toBe(err);
    expect(stageForActResult(ok, 'click', 'ap-1')).toBe(ok);
  });
});
