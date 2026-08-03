import { describe, it, expect, vi, type Mock } from 'vitest';
import { applyCdpDebugPortFence, decideCdpDebugPort } from '../../src/main/cdp-fence';

const portSwitch = (d: ReturnType<typeof decideCdpDebugPort>) =>
  d.switches.find((s) => s.name === 'remote-debugging-port');
const addressSwitch = (d: ReturnType<typeof decideCdpDebugPort>) =>
  d.switches.find((s) => s.name === 'remote-debugging-address');

describe('decideCdpDebugPort — the fence', () => {
  it('opens no port and says nothing when the variable is unset: the default install carries no debug surface', () => {
    const d = decideCdpDebugPort({ port: undefined, isPackaged: false });
    expect(d.switches).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it('treats an empty string as unset, never as a configured value', () => {
    // An empty env string is a real shape (`WIGOLO_STUDIO_CDP_PORT=` in a shell/launchd plist).
    // Passing '' through to appendSwitch would hand Chromium a switch with no value, whose
    // parse is not ours to predict. Absent means absent.
    const d = decideCdpDebugPort({ port: '', isPackaged: false });
    expect(d.switches).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it('REFUSES the switch on a packaged build — the threat is the packaged app holding a real signed-in profile', () => {
    const d = decideCdpDebugPort({ port: '9222', isPackaged: true });
    // The entire security benefit of the fence is this line: no port switch reaches Chromium,
    // so no amount of env-var setting on a user's machine can open a debug port into the
    // process that holds their authenticated profile.
    expect(portSwitch(d)).toBeUndefined();
    expect(d.switches).toEqual([]);
  });

  it('tells the operator the variable was ignored rather than failing silently', () => {
    const d = decideCdpDebugPort({ port: '9222', isPackaged: true });
    // Silence here is the trap the d14 spike already paid for once: a knob that quietly does
    // nothing produces confidently wrong conclusions downstream. Say it was ignored.
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatch(/IGNORED/);
    expect(d.warnings[0]).toContain('WIGOLO_STUDIO_CDP_PORT');
  });

  it('honours the switch on a development build, because the e2e suite drives this seam', () => {
    const d = decideCdpDebugPort({ port: '9222', isPackaged: false });
    expect(portSwitch(d)).toEqual({ name: 'remote-debugging-port', value: '9222' });
  });

  it('pins the debug listener to loopback whenever it is honoured', () => {
    const d = decideCdpDebugPort({ port: '9222', isPackaged: false });
    // Loopback is Chromium's default today, but "default" is not a guarantee across versions.
    // An off-box bind would make the debug port remotely reachable, which is a different and
    // far worse exposure than a local one.
    expect(addressSwitch(d)).toEqual({ name: 'remote-debugging-address', value: '127.0.0.1' });
  });

  it('pins loopback from a literal, so no input can redirect the bind', () => {
    const d = decideCdpDebugPort({ port: '9222', isPackaged: false, });
    const addr = addressSwitch(d);
    expect(addr?.value).toBe('127.0.0.1');
    // There is deliberately no input that feeds the address: the only caller-supplied value is
    // the port, and it is validated as a bare integer below.
    expect(JSON.stringify(d.switches)).not.toContain('0.0.0.0');
  });

  it('warns loudly and names what is exposed when it IS honoured', () => {
    const d = decideCdpDebugPort({ port: '9222', isPackaged: false });
    expect(d.warnings).toHaveLength(1);
    const w = d.warnings[0]!;
    // "Loud" means the warning states the consequence, not just the fact. An operator who
    // reads it should understand that the signed-in profile is what is on the line.
    expect(w).toMatch(/SECURITY/);
    expect(w).toContain('9222');
    expect(w).toMatch(/profile/i);
    expect(w).toContain('WIGOLO_STUDIO_CDP_PORT');
  });

  it('uses isPackaged as the discriminator, NOT NODE_ENV', () => {
    // A user or an MDM policy can set any env var globally; isPackaged is a property of the
    // build and cannot be talked into changing. This test is the one that fails if someone
    // "helpfully" reintroduces an env-var escape hatch.
    const d = decideCdpDebugPort({ port: '9222', isPackaged: true, nodeEnv: 'development' });
    expect(d.switches).toEqual([]);
    expect(d.warnings[0]).toMatch(/IGNORED/);
  });

  it('refuses a packaged build before it even validates the port', () => {
    // Ordering matters for the message: on a packaged build the variable is ignored because it
    // is a packaged build, whatever it contains. A "bad port" message there would mislead an
    // operator into thinking a good port would have worked.
    const d = decideCdpDebugPort({ port: 'not-a-port', isPackaged: true });
    expect(d.switches).toEqual([]);
    expect(d.warnings[0]).toMatch(/IGNORED/);
  });

  it.each([
    ['not-a-port', 'non-numeric'],
    ['0', 'below the valid range'],
    ['65536', 'above the valid range'],
    ['-1', 'negative'],
    ['9222.5', 'not an integer'],
    ['9222 --remote-allow-origins=*', 'extra switch text smuggled into the value'],
    ['0x2406', 'hex'],
    [' 9222', 'padded'],
  ])('refuses %s (%s) even on a development build', (raw) => {
    const d = decideCdpDebugPort({ port: raw, isPackaged: false });
    // The value reaches a Chromium command line. Only a bare integer in range is accepted, so
    // a malformed or padded value can never be handed to the switch parser to interpret.
    expect(d.switches).toEqual([]);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatch(/not a valid port/);
  });

  it('accepts the boundary ports', () => {
    for (const p of ['1', '65535']) {
      const d = decideCdpDebugPort({ port: p, isPackaged: false });
      expect(portSwitch(d)).toEqual({ name: 'remote-debugging-port', value: p });
    }
  });
});

describe('applyCdpDebugPortFence — the adapter that runs against the real app', () => {
  type AppendSwitch = (name: string, value?: string) => void;
  const host = (isPackaged: boolean): { isPackaged: boolean; appendSwitch: Mock<AppendSwitch> } => ({
    isPackaged,
    appendSwitch: vi.fn<AppendSwitch>(),
  });

  it('appends both switches in order and emits the warning on a development build', () => {
    const h = host(false);
    const warn = vi.fn();
    applyCdpDebugPortFence(h, { WIGOLO_STUDIO_CDP_PORT: '9222' }, warn);
    expect(h.appendSwitch.mock.calls).toEqual([
      ['remote-debugging-port', '9222'],
      ['remote-debugging-address', '127.0.0.1'],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/\n$/);
  });

  it('appends NOTHING to the command line on a packaged build, whatever the env says', () => {
    const h = host(true);
    const warn = vi.fn();
    // This is the assertion that matters at the seam: the fence is only real if the switch never
    // reaches Chromium. Deciding correctly and then appending anyway would pass every pure test.
    applyCdpDebugPortFence(h, { WIGOLO_STUDIO_CDP_PORT: '9222', NODE_ENV: 'development' }, warn);
    expect(h.appendSwitch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays silent and appends nothing when the variable is absent — the default path', () => {
    const h = host(false);
    const warn = vi.fn();
    applyCdpDebugPortFence(h, {}, warn);
    expect(h.appendSwitch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
