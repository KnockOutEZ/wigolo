import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import electronPath from 'electron';
import { studioUaIdentity, uaOverrideParams } from '../../src/main/ua-identity';
import { hiddenWindowPresentation } from '../../src/main/hidden-mode';
import {
  PLATFORM_INDEPENDENT_APIS, PLATFORM_DEPENDENT_APIS,
  PLATFORM_INDEPENDENT_CODECS, PLATFORM_DEPENDENT_CODECS,
  linuxSpawnArgs,
} from '../helpers/parity-expectations';

/**
 * THE PARITY RELEASE GATE — the deterministic, offline, Playwright-free half (S9 §7 fixture 4).
 *
 * Of the five canon fixtures, four are third-party sites (`tls.peet.ws`,
 * `bot-detector.rebrowser.net`, CreepJS, Sannysoft) and none of them can gate a pull request: they go
 * down, they change probe sets without notice, and their verdicts move for reasons unrelated to this
 * repo. A gate that reds because someone else shipped a heuristic teaches reviewers to ignore it.
 * Those four are measured by the local live harness and reported with conditions stated. The vendored
 * BotD detector is the only fixture that reds ONLY when this repo changes, so it is the only one here.
 *
 * WHY THIS DOES NOT USE PLAYWRIGHT, measured rather than assumed: a Playwright-launched build of this
 * app reports `navigator.webdriver === true` and BotD returns `headless_chrome`, while the identical
 * build spawned as a plain child process reports `false` and a clean verdict. The e2e harness's own
 * automation switches are the signal. Any gate that read these surfaces over CDP would be scoring the
 * harness, so this one spawns Electron directly and the probe page posts its vector back over http.
 *
 * THE NEGATIVE CONTROL IS PART OF THE GATE, not a one-off probe run at review time. The `plain` arm
 * gets no identity at all, and the gate asserts BotD flags it as `electron`. A detector that cannot
 * fail is not a gate, and this is the assertion that keeps the other ones honest — if a future change
 * neuters the fixture, the control goes green and the gate reds.
 *
 * BOTH AXES: every arm runs hidden and visible on the same build. An identity that only holds up
 * while a human is watching the window is useless for the background work the bridge exists to serve.
 */
const RUN = !!process.env.RUN_STUDIO_E2E;
const FIXTURES = join(import.meta.dirname, 'fixtures');
const PROBE_MAIN = join(import.meta.dirname, 'botd-probe-main.mjs');
const CT: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };

interface BotdVerdict { bot: boolean; botKind: string | null; fired: string[] | null; componentStates: Record<string, 'ok' | 'error'> | null }
interface Coherence {
  userAgent: string; appVersion: string;
  brands: Array<{ brand: string; version: string }> | null;
  hints: Record<string, unknown> | null;
  webdriver: boolean; devicePixelRatio: number;
  languages: string[]; codecs: Record<string, string>; gatedApis: Record<string, boolean>;
  fonts: string[] | null; webglRenderer: string | null;
  visibilityState: string; hasFocus: boolean;
  rafFps: number | null; intervalRatio: number | null;
}
interface Probe { ready: boolean; botd?: BotdVerdict; botdError?: string; coherence?: Coherence; coherenceError?: string }
interface Arm { probe: Probe; navHeaders: IncomingHttpHeaders | null; requestsPaused: number | null; stderr: string }

/**
 * Ask the installed Electron what Chromium it actually carries, by running its own Node with
 * `ELECTRON_RUN_AS_NODE`. Nothing here is hardcoded or mapped from the Electron version: a table of
 * Electron-to-Chromium majors is exactly the kind of constant that goes stale one dependency bump
 * after it is written, and a wrong value here would make the gate assert the wrong major.
 */
function electronChromeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(String(electronPath), ['-e', "process.stdout.write(process.versions.chrome)"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('exit', () => (/^\d+\./.test(out) ? resolve(out.trim()) : reject(new Error(`could not read the substrate's engine version: ${JSON.stringify(out)}`))));
  });
}

const nativeUaFor = (platform: NodeJS.Platform, chromeVersion: string): string => {
  const token = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) app/1.0.0 Chrome/${chromeVersion} Electron/0.0.0 Safari/537.36`;
};

function startFixtureServer(): Promise<{ server: Server; origin: string; reports: Map<string, Probe>; navHeaders: Map<string, IncomingHttpHeaders> }> {
  const reports = new Map<string, Probe>();
  const navHeaders = new Map<string, IncomingHttpHeaders>();
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && u.pathname === '/report') {
      let buf = '';
      req.on('data', (c) => { buf += String(c); });
      req.on('end', () => {
        try { reports.set(u.searchParams.get('arm') ?? 'unknown', JSON.parse(buf) as Probe); } catch { /* a bad body is a missing row */ }
        res.writeHead(204); res.end();
      });
      return;
    }
    const arm = u.searchParams.get('arm');
    if (arm && u.pathname.endsWith('.html')) navHeaders.set(arm, req.headers);
    const path = u.pathname === '/' ? '/parity-probe.html' : u.pathname;
    const file = join(FIXTURES, path.replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': CT[ext] ?? 'application/octet-stream',
      // Request the high-entropy hints so `Sec-CH-UA-Full-Version-List` can be read ON THE WIRE — the
      // reading phase 1 had to defer, because Chromium will not persist `Accept-CH` for an origin whose
      // certificate came through a verify-proc override. Loopback http is a secure context, so it can.
      'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model',
    });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, origin: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, reports, navHeaders });
    });
  });
}

describe.skipIf(!RUN)('parity release gate — vendored BotD, no automation harness attached', () => {
  let server: Server;
  const arms = new Map<string, Arm>();

  beforeAll(async () => {
    const fx = await startFixtureServer();
    server = fx.server;
    const chromeVersion = await electronChromeVersion();
    // The identity PRODUCTION computes. The probe main is handed this and applies it verbatim — it
    // contains no identity logic of its own, so the gate cannot pass while production drifts.
    const identity = studioUaIdentity({
      nativeUserAgent: nativeUaFor(process.platform, chromeVersion),
      chromeVersion,
      platform: process.platform,
    });
    const override = uaOverrideParams(identity, null, process.platform);
    for (const arm of ['identity', 'plain'] as const) {
      for (const hidden of [false, true]) {
        const key = `${arm}-${hidden ? 'hidden' : 'visible'}`;
        const dataDir = mkdtempSync(join(tmpdir(), `wigolo-botd-${key}-`));
        const lines: string[] = [];
        const child = spawn(String(electronPath), [PROBE_MAIN, ...linuxSpawnArgs()], {
          env: {
            ...process.env,
            WIGOLO_DATA_DIR: dataDir,
            WIGOLO_PROBE_ARM: arm,
            WIGOLO_PROBE_HIDDEN: hidden ? '1' : '0',
            WIGOLO_PROBE_URL: `${fx.origin}/parity-probe.html?arm=${key}&report=${encodeURIComponent(`${fx.origin}/report?arm=${key}`)}`,
            WIGOLO_PROBE_OVERRIDE: JSON.stringify(override),
            // Also production's own values, for the same no-drift reason as the override.
            WIGOLO_PROBE_PRESENTATION: JSON.stringify(hiddenWindowPresentation()),
            WIGOLO_PROBE_BUDGET_MS: '20000',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.stderr.on('data', (d) => lines.push(String(d)));
        await new Promise<void>((r) => child.on('exit', () => r()));
        const pausedLine = lines.join('').split('\n').reverse().find((l) => l.includes('requests_paused'));
        arms.set(key, {
          probe: fx.reports.get(key) ?? { ready: false },
          navHeaders: fx.navHeaders.get(key) ?? null,
          requestsPaused: pausedLine ? (JSON.parse(pausedLine) as { requests_paused: number }).requests_paused : null,
          // Kept so a non-reporting arm says WHY. Without it a launch failure surfaces as
          // `{"ready":false}` with no cause, which is what the first CI run of this gate produced.
          stderr: lines.join(''),
        });
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }, 300_000);

  afterAll(async () => { await new Promise<void>((r) => server?.close(() => r())); });

  const arm = (k: string): Arm => {
    const a = arms.get(k);
    if (!a) throw new Error(`arm ${k} never ran`);
    if (!a.probe.ready) {
      throw new Error(`arm ${k} never reported: ${JSON.stringify(a.probe)}\nchild stderr:\n${a.stderr.slice(-4000) || '(empty)'}`);
    }
    return a;
  };
  const shipped = (): Arm[] => [arm('identity-visible'), arm('identity-hidden')];

  describe('the negative control — a gate whose detector cannot fire is not a gate', () => {
    it('FLAGS the arm with no identity applied, in both window states: this is what proves the other assertions in this file have teeth', () => {
      for (const key of ['plain-visible', 'plain-hidden']) {
        const a = arm(key);
        expect(a.probe.botd!.bot, key).toBe(true);
      }
    });

    it('flags it as ELECTRON specifically — asserted on the per-detector results rather than the final `botKind`, because the verdict collapses several simultaneous positives into one and which of them wins its tie-break is not a property this repo controls', () => {
      for (const key of ['plain-visible', 'plain-hidden']) {
        const fired = arm(key).probe.botd!.fired;
        if (fired === null) continue; // older bundle without getDetections; `bot === true` still stands
        expect(fired.join(','), key).toMatch(/electron/);
      }
    });

    it('flags it off the identity strings specifically — the control must fail for the reason the gate is about, not incidentally', () => {
      const c = arm('plain-visible').probe.coherence!;
      expect(c.userAgent).toMatch(/Electron\//);
      expect(c.appVersion).toMatch(/Electron\//);
    });
  });

  describe('the shipped condition — debugger attached, SSRF fence armed, identity applied', () => {
    it('returns NO bot verdict, in both window states', () => {
      for (const a of shipped()) {
        expect(a.probe.botdError).toBeUndefined();
        expect(a.probe.botd!.botKind).toBeNull();
        expect(a.probe.botd!.bot).toBe(false);
      }
    });

    it('reports navigator.webdriver false even with a debugger attached — an attached debugger setting this flag would be a permanent tell on every driven tab, so it is asserted rather than assumed', () => {
      for (const a of shipped()) expect(a.probe.coherence!.webdriver).toBe(false);
    });

    it('proves the SSRF fence really was armed during the measurement: a zero pause count would mean the clean verdict was collected with the fence off, which is not the shipped condition', () => {
      for (const key of ['identity-visible', 'identity-hidden']) {
        expect(arm(key).requestsPaused, key).toBeGreaterThan(0);
      }
    });

    it('cannot reach window.process from the page: BotD flags Electron off `process.type === "renderer"`, so a collected value there would mean contextIsolation or the sandbox had been dropped', () => {
      for (const a of shipped()) {
        const states = a.probe.botd!.componentStates;
        if (states) expect(states.process).not.toBe('ok');
      }
    });

    it('collected the identity-bearing sources rather than skipping them — "no bot" from a source that failed is a different fact from "no bot" from one that read a clean value', () => {
      for (const a of shipped()) {
        const states = a.probe.botd!.componentStates;
        if (!states) continue;
        for (const key of ['userAgent', 'appVersion', 'webDriver', 'distinctiveProps']) {
          expect(states[key], `${key} did not collect`).toBe('ok');
        }
      }
    });
  });

  describe('consistency coherence (§4) — contradiction is what 2026 detectors score', () => {
    it('agrees on the claimed major across the UA string, userAgentData.brands, and the Sec-CH-UA header ACTUALLY ON THE WIRE', () => {
      for (const key of ['identity-visible', 'identity-hidden']) {
        const a = arm(key);
        const major = /Chrome\/(\d+)\./.exec(a.probe.coherence!.userAgent)?.[1];
        expect(major, `${key}: no Chrome major in the UA`).toBeTruthy();
        for (const b of a.probe.coherence!.brands ?? []) {
          if (/not.a.brand/i.test(b.brand)) continue;
          expect(b.version, `${key}: brand ${b.brand}`).toBe(major);
        }
        const wire = String(a.navHeaders?.['sec-ch-ua'] ?? '');
        for (const m of [...wire.matchAll(/"([^"]+)";v="([^"]+)"/g)]) {
          if (/not.a.brand/i.test(m[1]!)) continue;
          expect(m[2], `${key}: wire Sec-CH-UA ${m[1]}`).toBe(major);
        }
      }
    });

    it('presents exactly the engine\'s own two brands and never `Google Chrome`: that is a product claim this substrate is not, and human tabs have no mechanism that could match it', () => {
      for (const a of shipped()) {
        expect((a.probe.coherence!.brands ?? []).map((b) => b.brand)).toEqual(['Not;A=Brand', 'Chromium']);
      }
    });

    it('carries no Electron token and no app token in the UA or appVersion', () => {
      for (const a of shipped()) {
        expect(a.probe.coherence!.userAgent).not.toMatch(/Electron/i);
        expect(a.probe.coherence!.appVersion).not.toMatch(/Electron/i);
        expect(a.probe.coherence!.userAgent).not.toMatch(/wigolo/i);
      }
    });

    it('supports every codec Chromium builds on every platform', () => {
      for (const a of shipped()) {
        for (const codec of PLATFORM_INDEPENDENT_CODECS) {
          expect(a.probe.coherence!.codecs[codec], codec).toBe('probably');
        }
      }
    });

    // hev1 is THE pre-settled ceiling (spec §4 item 5): `probably` on the macOS build, empty on the
    // Linux one, because HEVC is a licensing-dependent build flag — and real Chrome on Linux answers
    // the same way. Asserting the macOS value cross-platform was wrong, and CI caught it. What IS
    // assertable is that the answer does not differ between arms, since only this repo's own
    // configuration could cause that.
    it('gives the SAME answer for the licensing-gated codecs in every window state, even where the platform does not carry them', () => {
      const v = arm('identity-visible').probe.coherence!.codecs;
      const h = arm('identity-hidden').probe.coherence!.codecs;
      for (const codec of PLATFORM_DEPENDENT_CODECS) expect(h[codec], codec).toBe(v[codec]);
    });

    it('exposes the version-gated APIs the claimed major ships on EVERY platform — spoofed profiles get caught for MISSING the APIs their claimed version has, so a claim of 150 over a smaller surface must red', () => {
      for (const a of shipped()) {
        for (const api of PLATFORM_INDEPENDENT_APIS) {
          expect(a.probe.coherence!.gatedApis[api], `${api} missing for the claimed major`).toBe(true);
        }
      }
    });

    // `BarcodeDetector` is macOS/ChromeOS-only in Chromium and WebHID/WebUSB/Web Serial vary with the
    // desktop environment, so their absolute values need a same-platform real-Chrome reference that CI
    // does not have. The cross-arm comparison is the part with teeth here.
    it('reports the platform-gated APIs identically in every window state', () => {
      const v = arm('identity-visible').probe.coherence!.gatedApis;
      const h = arm('identity-hidden').probe.coherence!.gatedApis;
      for (const api of PLATFORM_DEPENDENT_APIS) expect(h[api], api).toBe(v[api]);
    });

    it('keeps a real GPU renderer string and a coherent devicePixelRatio — a real renderer reporting dpr 0 is exactly the contradiction to avoid, and it is what offscreen rendering would produce', () => {
      for (const a of shipped()) {
        expect(a.probe.coherence!.devicePixelRatio).toBeGreaterThan(0);
        expect(a.probe.coherence!.webglRenderer).toBeTruthy();
      }
    });

    it('reports a plausible, non-empty font set for the platform rather than an empty or padded list', () => {
      for (const a of shipped()) {
        expect(a.probe.coherence!.fonts).not.toBeNull();
        expect(a.probe.coherence!.fonts!.length).toBeGreaterThan(0);
      }
    });
  });

  describe('hidden vs visible on the same build (checklist item 6)', () => {
    const v = (): Coherence => arm('identity-visible').probe.coherence!;
    const h = (): Coherence => arm('identity-hidden').probe.coherence!;

    it('presents an identical identity and capability surface in both window states', () => {
      expect(h().userAgent).toBe(v().userAgent);
      expect(h().brands).toEqual(v().brands);
      expect(h().gatedApis).toEqual(v().gatedApis);
      expect(h().codecs).toEqual(v().codecs);
      expect(h().fonts).toEqual(v().fonts);
      expect(h().webglRenderer).toBe(v().webglRenderer);
      expect(h().devicePixelRatio).toBe(v().devicePixelRatio);
    });

    it('reports visibilityState `visible` on a window that was never shown — the page is not occluded, and a hidden window is not a background tab', () => {
      expect(h().visibilityState).toBe('visible');
    });

    it('keeps real rAF cadence while hidden: backgroundThrottling is off, and a throttled hidden window is both trivially detectable and broken for drives', () => {
      expect(h().rafFps).toBeGreaterThan(30);
      // A deliberately loose bound. CI runners are noisy; the failure this guards against — clamping
      // to roughly 1fps — is an order of magnitude away, so a tight bound would only buy flakes.
      expect(h().rafFps!).toBeGreaterThan(v().rafFps! / 2);
    });

    it('keeps real timer cadence while hidden — clamping background timers to 1s is the classic occluded-tab tell', () => {
      expect(h().intervalRatio).toBeGreaterThan(0.5);
    });

    // A RECORDED CEILING, not a spoof. `document.hasFocus()` is false on a never-shown window, which
    // is also true of every unfocused real tab. Faking it would mean patching `document`, which §4's
    // no-spoof rule forbids, and the fake would be the contradiction rather than the honest value.
    it('is honest about document.hasFocus(): false while hidden, which is the normal state of an unfocused real tab', () => {
      expect(h().hasFocus).toBe(false);
    });
  });
});
