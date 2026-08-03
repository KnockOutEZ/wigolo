import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  studioUaIdentity,
  uaOverrideParams,
  uaPlatformName,
  parseHostHints,
  applyUaIdentityToTab,
  HOST_HINTS_EXPR,
  type HostHints,
} from '../../src/main/ua-identity';

// The measured native UA of the Electron 43 substrate on macOS, verbatim from the phase-1 spike, with
// the embedding app's own token in front of it (Electron appends `<appName>/<appVersion>` too).
const NATIVE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) wigolo-studio/0.1.0 Chrome/150.0.7871.46 Electron/43.0.0 Safari/537.36';
const CHROME_VERSION = '150.0.7871.46';

const identity = (): ReturnType<typeof studioUaIdentity> =>
  studioUaIdentity({ nativeUserAgent: NATIVE, chromeVersion: CHROME_VERSION, platform: 'darwin' });

const HINTS: HostHints = {
  platform: 'macOS',
  platformVersion: '15.6.0',
  architecture: 'arm',
  bitness: '64',
  model: '',
  mobile: false,
};

describe('studioUaIdentity — presents the engine, minus what it is not', () => {
  it('carries no Electron token: that token is a free tell on every single request, and it is the one thing no browser sends', () => {
    expect(identity().userAgent).not.toMatch(/Electron/i);
  });

  it('carries no embedding-app token either — the app name leaks just as loudly as the Electron one', () => {
    expect(identity().userAgent).not.toContain('wigolo');
  });

  it('reduces the build in the UA string, because real Chrome reduces it and an exact build is only ever seen from a non-Chrome client', () => {
    expect(identity().userAgent).toContain('Chrome/150.0.0.0');
    expect(identity().userAgent).not.toContain('150.0.7871.46');
  });

  it('claims the major the engine ACTUALLY is — the whole no-spoof lane rests on this, so it is read from the build, never configured', () => {
    expect(identity().major).toBe('150');
    const next = studioUaIdentity({ nativeUserAgent: NATIVE, chromeVersion: '151.0.7922.72', platform: 'darwin' });
    expect(next.major).toBe('151');
    expect(next.userAgent).toContain('Chrome/151.0.0.0');
  });

  it('keeps the platform token the engine itself generated rather than deriving one, so the OS half cannot disagree with the host', () => {
    expect(identity().userAgent).toContain('(Macintosh; Intel Mac OS X 10_15_7)');
  });

  it('falls back to a canonical platform token when the native string is unparseable, instead of shipping a malformed UA', () => {
    const win = studioUaIdentity({ nativeUserAgent: 'garbage', chromeVersion: CHROME_VERSION, platform: 'win32' });
    expect(win.userAgent).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    );
  });

  it('refuses to build an identity from an unusable engine version rather than claiming Chrome/.0.0.0', () => {
    expect(() => studioUaIdentity({ nativeUserAgent: NATIVE, chromeVersion: '', platform: 'darwin' })).toThrow();
  });
});

describe('brands — exactly the engine\'s own two, at the engine\'s own major', () => {
  it('presents TWO brands and NOT `Google Chrome`: that is a product claim this substrate is not, and human tabs have no mechanism to match it', () => {
    const brands = identity().brands;
    expect(brands.map((b) => b.brand)).toEqual(['Not;A=Brand', 'Chromium']);
    expect(brands.some((b) => b.brand === 'Google Chrome')).toBe(false);
  });

  it('agrees with the UA string\'s major on every brand — a brand list at a different major IS the contradiction detectors score', () => {
    const id = identity();
    const uaMajor = /Chrome\/(\d+)\./.exec(id.userAgent)![1];
    for (const b of id.brands) {
      if (b.brand === 'Not;A=Brand') continue;
      expect(b.version).toBe(uaMajor);
    }
  });

  it('reports the TRUE build in the full version list, where real Chrome reports its own — a rounded `.0.0` there is a gratuitous tell with no upside', () => {
    const fvl = identity().fullVersionList;
    expect(fvl.find((b) => b.brand === 'Chromium')!.version).toBe(CHROME_VERSION);
    expect(identity().fullVersion).toBe(CHROME_VERSION);
  });
});

describe('uaOverrideParams — the driven-tab override is built from the SAME identity', () => {
  it('sends the identical UA string the process-wide fallback presents; a second derivation is how the two classes drift apart', () => {
    const id = identity();
    expect(uaOverrideParams(id, HINTS, 'darwin').userAgent).toBe(id.userAgent);
  });

  it('sends the identical brands, so an agent tab and a human tab in one window cannot present two identities to one cookie', () => {
    const id = identity();
    const p = uaOverrideParams(id, HINTS, 'darwin');
    expect(p.userAgentMetadata.brands).toEqual(id.brands);
    expect(p.userAgentMetadata.fullVersionList).toEqual(id.fullVersionList);
  });

  it('passes the host\'s own high-entropy hints through untouched — the engine already knows the OS version and this module must not restate it', () => {
    const m = uaOverrideParams(identity(), HINTS, 'darwin').userAgentMetadata;
    expect(m.platform).toBe('macOS');
    expect(m.platformVersion).toBe('15.6.0');
    expect(m.architecture).toBe('arm');
    expect(m.bitness).toBe('64');
    expect(m.mobile).toBe(false);
  });

  it('omits rather than invents when the hints could not be read: an empty string teaches a site nothing, a fabricated OS version can be cross-checked', () => {
    const m = uaOverrideParams(identity(), null, 'darwin').userAgentMetadata;
    expect(m.platform).toBe('macOS');
    expect(m.platformVersion).toBe('');
    expect(m.architecture).toBe('');
    expect(m.bitness).toBe('');
  });

  it('spells the platform the way client hints do, not the way Node does', () => {
    expect(uaPlatformName('darwin')).toBe('macOS');
    expect(uaPlatformName('win32')).toBe('Windows');
    expect(uaPlatformName('linux')).toBe('Linux');
  });
});

describe('parseHostHints', () => {
  it('accepts a real getHighEntropyValues result', () => {
    expect(parseHostHints({ ...HINTS })).toEqual(HINTS);
  });

  it('rejects a result missing the fields only the engine can supply, so a partial read degrades to omitted rather than half-filled', () => {
    expect(parseHostHints({ platform: 'macOS' })).toBeNull();
    expect(parseHostHints(null)).toBeNull();
    expect(parseHostHints('macOS')).toBeNull();
  });

  it('reads mobile strictly: anything that is not the boolean true is false, because a truthy string would claim a phone', () => {
    expect(parseHostHints({ platform: 'macOS', platformVersion: '15.6.0', mobile: 'yes' })!.mobile).toBe(false);
  });
});

describe('applyUaIdentityToTab — ordering is the trap this exists to encode', () => {
  const spy = (over: Partial<Parameters<typeof applyUaIdentityToTab>[0]> = {}) => {
    const calls: string[] = [];
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const deps = {
      identity: identity(),
      platform: 'darwin' as NodeJS.Platform,
      loadBlank: async () => { calls.push('loadBlank'); },
      readHostHints: async () => { calls.push('readHostHints'); return { ...HINTS }; },
      sendCdp: async (method: string, params: Record<string, unknown>) => { calls.push('sendCdp'); sent.push({ method, params }); return {}; },
      warn: (line: string) => { calls.push(`warn:${line.slice(0, 20)}`); },
      ...over,
    };
    return { calls, sent, deps };
  };

  it('loads about:blank BEFORE sending Emulation: an Emulation command on a never-navigated webContents never resolves, so the reverse order hangs the tab forever', async () => {
    const { calls, deps } = spy();
    await applyUaIdentityToTab(deps);
    expect(calls.indexOf('loadBlank')).toBe(0);
    expect(calls.indexOf('loadBlank')).toBeLessThan(calls.indexOf('sendCdp'));
  });

  it('sends exactly Emulation.setUserAgentOverride — the one mechanism measured to move the string, the brands and Sec-CH-UA together', async () => {
    const { sent, deps } = spy();
    await applyUaIdentityToTab(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('Emulation.setUserAgentOverride');
    expect(sent[0]!.params.userAgent).toBe(identity().userAgent);
  });

  it('reads the host hints before overriding, because after the override the engine reports the override back', async () => {
    const { calls, deps } = spy();
    await applyUaIdentityToTab(deps);
    expect(calls.indexOf('readHostHints')).toBeLessThan(calls.indexOf('sendCdp'));
  });

  it('still applies the override when the hint read rejects — losing the hints must not cost the whole identity', async () => {
    const { sent, deps } = spy({ readHostHints: async () => { throw new Error('no userAgentData'); } });
    const ok = await applyUaIdentityToTab(deps);
    expect(ok).toBe(true);
    expect(sent[0]!.method).toBe('Emulation.setUserAgentOverride');
  });

  it('fails OPEN and warns when the override itself fails: the tab then presents the substrate\'s own identity, which is worse for anti-bot but is not a fence, so refusing the session would trade a legitimacy regression for an outage', async () => {
    const warned: string[] = [];
    const { deps } = spy({
      sendCdp: async () => { throw new Error('debugger detached'); },
      warn: (l: string) => { warned.push(l); },
    });
    await expect(applyUaIdentityToTab(deps)).resolves.toBe(false);
    expect(warned.join('')).toContain('identity override failed');
  });

  it('never resolves before the blank load does — returning early would let the first real navigation race the override', async () => {
    let released = (): void => {};
    const gate = new Promise<void>((r) => { released = r; });
    let done = false;
    const { deps } = spy({ loadBlank: () => gate });
    const p = applyUaIdentityToTab(deps).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    released();
    await p;
    expect(done).toBe(true);
  });
});

describe('structural — one identity, computed once', () => {
  const mainDir = join(import.meta.dirname, '../../src/main');
  const read = (f: string): string => readFileSync(join(mainDir, f), 'utf-8');

  it('computes the identity exactly ONCE in main: two computations is how the human\'s tabs and the agent\'s tabs drift into two identities', () => {
    const src = read('index.ts');
    expect(src.match(/studioUaIdentity\(/g) ?? []).toHaveLength(1);
  });

  it('sets the process-wide fallback from that same identity, so every session — human tabs and the shell included — inherits it', () => {
    expect(read('index.ts')).toContain('app.userAgentFallback = uaIdentity.userAgent');
  });

  it('keeps Emulation OUT of the tab attach step, where it would be issued before any navigation exists and never resolve', () => {
    expect(read('drive-engine.ts')).not.toContain('Emulation');
  });

  it('reads the hints with the shared expression rather than a hand-written copy that can drift from the parser', () => {
    expect(read('index.ts')).toContain('HOST_HINTS_EXPR');
    expect(HOST_HINTS_EXPR).toContain('getHighEntropyValues');
  });
});
