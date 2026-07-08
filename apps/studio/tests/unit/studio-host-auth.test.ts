import { describe, it, expect, vi } from 'vitest';
import type { DebuggerLike } from '../../src/main/cdp-transport';
import { createDriveEngine, type TabDrive } from '../../src/main/drive-engine';
import { createStudioHost, type HostTab } from '../../src/main/studio-host';
import { makeFakeBroker } from '../helpers/fake-broker';
import type { StorageStateOut, StudioObserveOutput, MarkPayload } from 'wigolo/studio';

const viewport = () => ({ width: 800, height: 600 });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const attrsArr = (o: Record<string, string> = {}): string[] => Object.entries(o).flat();
const el = (be: number, localName: string, attrs: Record<string, string> = {}, children: unknown[] = []) => ({
  backendNodeId: be,
  nodeType: 1,
  localName,
  nodeName: localName.toUpperCase(),
  attributes: attrsArr(attrs),
  children,
});

/** A CDP debugger whose page has a password field IFF credRef.v — flips the credential-context signal live. */
function authDebugger(credRef: { v: boolean }): DebuggerLike {
  let attached = false;
  const build = () => {
    const bodyKids: unknown[] = [el(10, 'button', { id: 'go' })];
    const nodes: Array<{ ignored: boolean; role: { value: string }; name: { value: string }; backendDOMNodeId: number }> = [
      { ignored: false, role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 10 },
    ];
    if (credRef.v) {
      bodyKids.push(el(30, 'input', { type: 'password', name: 'pw' }));
      nodes.push({ ignored: false, role: { value: 'textbox' }, name: { value: 'Password' }, backendDOMNodeId: 30 });
    }
    return {
      nodes,
      root: { backendNodeId: 1, nodeType: 9, nodeName: '#document', children: [el(2, 'html', {}, [el(3, 'body', {}, bodyKids)])] },
    };
  };
  return {
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    isAttached: () => attached,
    sendCommand: async (method: string) => {
      switch (method) {
        case 'Accessibility.getFullAXTree':
          return { nodes: build().nodes };
        case 'DOM.getDocument':
          return { root: build().root };
        case 'Page.getLayoutMetrics':
          return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        default:
          return {};
      }
    },
    on: () => {},
    removeListener: () => {},
  };
}

const SID = {
  name: 'sid',
  value: 'SECRET_TOKEN_VALUE',
  domain: 'example.com',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
};

function fakeProfileStore() {
  const blobs = new Map<string, { boundOrigin: string; storageState: string }>();
  return {
    blobs,
    set: vi.fn(async (id: string, boundOrigin: string, ss: string) => {
      blobs.set(id, { boundOrigin, storageState: ss });
    }),
    get: vi.fn(async (id: string) => {
      const b = blobs.get(id);
      return b
        ? { ok: true as const, boundOrigin: b.boundOrigin, storageState: b.storageState }
        : { ok: false as const, reason: 'profile_absent' as const };
    }),
  };
}

interface HarnessOpts {
  credRef: { v: boolean };
  urlRef: { v: string };
  storage: { cookies: StorageStateOut['cookies'] };
  profileStore?: ReturnType<typeof fakeProfileStore>;
}

function makeAuthHost(opts: HarnessOpts) {
  const engine = createDriveEngine();
  const loginPushes: Array<{ sessionId: string; state: string; origin?: string }> = [];
  const order: string[] = [];
  const applied: StorageStateOut[] = [];
  let drive: TabDrive | undefined;
  const host = createStudioHost({
    config: { handoffPollIntervalMs: 1, handoffMaxPolls: 50, dataDir: '/tmp/wigolo-p5-test' },
    broker: makeFakeBroker(),
    onParked: () => {},
    onLoginHandoff: (m) => loginPushes.push(m),
    profileStore: opts.profileStore,
    createTab: async ({ initialHolder, grant }) => {
      drive = await engine.attachTab('t1', { debugger: authDebugger(opts.credRef), viewport, grant, initialHolder });
      const tab: HostTab = {
        tabId: 't1',
        drive,
        browser: {
          navigate: async (u: string) => {
            order.push('nav');
            opts.urlRef.v = u;
          },
        },
        currentUrl: () => opts.urlRef.v,
        readHtml: async () => '<html></html>',
        storageState: async () => ({ cookies: [...opts.storage.cookies], origins: [] }),
        applyStorageState: async (s) => {
          applied.push(s);
          order.push('apply');
        },
      };
      return tab;
    },
    closeTab: () => { void engine.detachTab('t1'); },
  });
  return { host, loginPushes, order, applied, getHolder: () => drive?.controlToken.holder };
}

const MINIMAL_PAYLOAD: MarkPayload = {
  tag: 'button',
  id: '',
  classes: [],
  attrs: {},
  dataset: {},
  text: 'x',
  component: null,
  source: null,
};

describe('studio host login-handoff wiring (P5)', () => {
  it('POSITIVE: an agent act on a credential page reclaims to human + pushes in_progress + observe carries login_handoff', async () => {
    const credRef = { v: true };
    const urlRef = { v: 'https://example.com/login' };
    const { host, loginPushes, getHolder } = makeAuthHost({ credRef, urlRef, storage: { cookies: [] } });
    const opened = (await host.handlers.spawn({ startUrl: 'https://example.com/login' })) as { session_id: string };

    await host.handlers.act({ action: 'click', ref: 'e1' });

    expect(getHolder()).toBe('human');
    expect(loginPushes).toContainEqual({ sessionId: opened.session_id, state: 'in_progress', origin: 'https://example.com' });

    const obs = (await host.handlers.observe({})) as StudioObserveOutput;
    expect(obs.credentialContext).toBe(true);
    expect(obs.elements).toEqual([]);
    expect(obs.login_handoff?.state).toBe('in_progress');
    expect(obs.login_handoff?.doNotRetry).toBe(true);
  });

  it('NEGATIVE: an agent act on a NON-credential page does NOT reclaim and NEVER pushes a login handoff', async () => {
    const credRef = { v: false };
    const urlRef = { v: 'https://example.com/home' };
    const { host, loginPushes, getHolder } = makeAuthHost({ credRef, urlRef, storage: { cookies: [] } });
    await host.handlers.spawn({ startUrl: 'https://example.com/home' });

    await host.handlers.act({ action: 'click', ref: 'e1' });

    expect(getHolder()).toBe('agent');
    expect(loginPushes).toHaveLength(0);
  });

  it('completion (left credential ctx AND storage delta) re-grants the agent AND persists the origin-scoped profile — via the poll', async () => {
    const credRef = { v: true };
    const urlRef = { v: 'https://example.com/login' };
    const storage = { cookies: [] as StorageStateOut['cookies'] };
    const profileStore = fakeProfileStore();
    const { host, loginPushes, getHolder } = makeAuthHost({ credRef, urlRef, storage, profileStore });
    await host.handlers.spawn({ startUrl: 'https://example.com/login' });

    await host.handlers.act({ action: 'click', ref: 'e1' }); // → in_progress, baseline storage empty
    expect(getHolder()).toBe('human');

    // Human "logs in": leaves the credential context AND a real new cookie appears for the wall origin.
    credRef.v = false;
    urlRef.v = 'https://example.com/home';
    storage.cookies = [SID];

    await wait(40); // let the 1ms poll fire checkCompletion

    expect(loginPushes.map((p) => p.state)).toContain('completed');
    expect(getHolder()).toBe('agent'); // re-granted on the completing path
    const { createHash } = await import('node:crypto');
    const expectedId = createHash('sha256').update('https://example.com').digest('hex');
    expect(profileStore.set).toHaveBeenCalledWith(
      expectedId,
      'https://example.com',
      expect.stringContaining('SECRET_TOKEN_VALUE'),
    );
  });

  it('loads a matching-origin profile into the session BEFORE the gated nav (ordering asserted)', async () => {
    const profileStore = fakeProfileStore();
    const { createHash } = await import('node:crypto');
    const id = createHash('sha256').update('https://example.com').digest('hex');
    await profileStore.set(id, 'https://example.com', JSON.stringify({ cookies: [SID], origins: [] }));

    const { host, order, applied } = makeAuthHost({
      credRef: { v: false },
      urlRef: { v: 'https://example.com/app' },
      storage: { cookies: [] },
      profileStore,
    });
    await host.handlers.spawn({ startUrl: 'https://example.com/app' });

    // loadProfile (apply) MUST run before the gated nav.
    expect(order.indexOf('apply')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('nav')).toBeGreaterThan(order.indexOf('apply'));
    expect(applied[0]).toEqual({ cookies: [SID], origins: [] });
  });

  it('NEGATIVE: a profile whose bound origin differs from the session origin is REFUSED at load (confused-deputy)', async () => {
    const profileStore = fakeProfileStore();
    const { createHash } = await import('node:crypto');
    // Store a blob under the sha256(example.com) key but with a DIFFERENT boundOrigin inside the envelope.
    const id = createHash('sha256').update('https://example.com').digest('hex');
    await profileStore.set(id, 'https://evil.com', JSON.stringify({ cookies: [SID], origins: [] }));

    const { host, applied } = makeAuthHost({
      credRef: { v: false },
      urlRef: { v: 'https://example.com/app' },
      storage: { cookies: [] },
      profileStore,
    });
    await host.handlers.spawn({ startUrl: 'https://example.com/app' });

    // loadProfile matched the id but r.boundOrigin ('https://evil.com') !== profileOrigin ('https://example.com')
    // → refuse to apply (defense-in-depth on top of the sha256(origin) key).
    expect(applied).toHaveLength(0);
  });

  it('close() during an active handoff LOCKs it — no re-grant, no completed even if a delta later appears', async () => {
    const credRef = { v: true };
    const urlRef = { v: 'https://example.com/login' };
    const storage = { cookies: [] as StorageStateOut['cookies'] };
    const profileStore = fakeProfileStore();
    const { host, loginPushes, getHolder } = makeAuthHost({ credRef, urlRef, storage, profileStore });
    const opened = (await host.handlers.spawn({ startUrl: 'https://example.com/login' })) as { session_id: string };

    await host.handlers.act({ action: 'click', ref: 'e1' });
    expect(loginPushes.map((p) => p.state)).toContain('in_progress');

    await host.handlers.close({ session_id: opened.session_id }); // LOCK (onClientGone)

    // What WOULD complete a live handoff:
    credRef.v = false;
    urlRef.v = 'https://example.com/home';
    storage.cookies = [SID];
    await wait(40);

    expect(loginPushes.map((p) => p.state)).not.toContain('completed');
    expect(getHolder()).toBe('human'); // never re-granted after teardown
    expect(profileStore.set).not.toHaveBeenCalled();
  });

  it('the credential window drops human content: a mark attempted while in_progress is refused at source', async () => {
    const credRef = { v: true };
    const urlRef = { v: 'https://example.com/login' };
    const { host } = makeAuthHost({ credRef, urlRef, storage: { cookies: [] } });
    await host.handlers.spawn({ startUrl: 'https://example.com/login' });
    await host.handlers.act({ action: 'click', ref: 'e1' }); // → in_progress (credential context)

    const r = await host.markElement({ tabId: 't1', path: [0], payload: MINIMAL_PAYLOAD });
    expect(r).toEqual(expect.objectContaining({ error_reason: 'credential_context' }));
  });

  it('NEGATIVE: no agent-reachable credential/login handler exists (the sealed handler set is unchanged)', () => {
    const { host } = makeAuthHost({ credRef: { v: false }, urlRef: { v: 'about:blank' }, storage: { cookies: [] } });
    const keys = Object.keys(host.handlers);
    expect(keys).not.toContain('loginAs');
    expect(keys).not.toContain('login');
    expect(keys).not.toContain('credential');
    expect(keys.sort()).toEqual(['act', 'capture', 'close', 'extractSet', 'list', 'marks', 'observe', 'say', 'spawn']);
  });
});
