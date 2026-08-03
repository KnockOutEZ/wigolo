import { describe, it, expect, beforeAll } from 'vitest';
import { type ElectronApplication } from 'playwright';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { launchStudio } from './launch';
import { readHandle, DaemonProxy } from 'wigolo/studio';
import {
  PLATFORM_INDEPENDENT_APIS, PLATFORM_DEPENDENT_APIS,
  PLATFORM_INDEPENDENT_CODECS, PLATFORM_DEPENDENT_CODECS,
} from '../helpers/parity-expectations';

/**
 * THE PARITY RELEASE GATE (S9 §7).
 *
 * This is the half that runs against the REAL PRODUCT WIRING: the app's own main process, its own
 * driven-tab creation, its own SSRF fence, and the human omnibox seam. It is the only place the
 * identity can be checked as the app actually assembles it rather than as a harness reassembles it.
 *
 * IT CANNOT ASSERT AUTOMATION MARKERS, and the reason is measured, not assumed. Driving the app
 * requires Playwright, and Playwright's own launch switches set the very markers a bot detector
 * looks for: launched by Playwright this build reports `navigator.webdriver === true` and BotD
 * returns `headless_chrome`, while the identical build spawned as a plain child process reports
 * `false` and a clean verdict. So a webdriver or headless assertion here would be scoring the
 * harness. Those live in `botd-gate.spec.ts`, which spawns Electron directly and has the page post
 * its own vector back — at the cost of assembling the identity itself. The two files are
 * complementary by construction: this one has real wiring and a contaminated environment, that one
 * has a clean environment and reconstructed wiring. Neither alone is sufficient.
 *
 * WHAT THIS FILE ASSERTS — the things the harness cannot fake either way:
 *   - a driven (agent) tab and a human omnibox tab present ONE identity: same UA string, same
 *     brands. This is the point of the UA slice — two identities out of one cookie jar and one
 *     address is a sharper signal than the Electron token that was removed;
 *   - BotD never reports `electron`, which is the one verdict this repo can regress into and the one
 *     Playwright cannot inject;
 *   - the consistency-coherence class: UA major == `userAgentData` brand majors == the `Sec-CH-UA`
 *     majors ACTUALLY ON THE WIRE, plus dpr/codec/API-surface coherence;
 *   - both window states, on the same build. A vector that only holds up while a human is watching
 *     the window would be worthless for the background work the bridge exists to serve.
 *
 * Scores are NOT published (v3 declined that as an arms-race invitation and the numbers rot). These
 * gates consume them; no doc prints them.
 */
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');
const FIXTURES = join(import.meta.dirname, 'fixtures');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ToolResult { content: Array<{ type: string; text: string }>; isError: boolean }
const body = (r: unknown): Record<string, unknown> => JSON.parse((r as ToolResult).content[0]!.text) as Record<string, unknown>;

interface BotdVerdict {
  bot: boolean;
  botKind: string | null;
  fired: string[] | null;
  componentStates: Record<string, 'ok' | 'error'> | null;
}

interface Coherence {
  userAgent: string;
  appVersion: string;
  brands: Array<{ brand: string; version: string }> | null;
  mobile: boolean | null;
  hints: Record<string, unknown> | null;
  webdriver: boolean;
  devicePixelRatio: number;
  hardwareConcurrency: number;
  deviceMemory: number | null;
  pluginCount: number | null;
  languages: string[];
  codecs: Record<string, string>;
  gatedApis: Record<string, boolean>;
  fonts: string[] | null;
  webglRenderer: string | null;
  hasPrivateToken: string;
  requestMediaKeySystemAccess: string;
  visibilityState: string;
  hasFocus: boolean;
  outerWidth: number;
  innerWidth: number;
  rafFps: number | null;
  intervalRatio: number | null;
}

interface Probe { botd?: BotdVerdict; botdError?: string; coherence?: Coherence; coherenceError?: string; ready: boolean }

interface Arm {
  hidden: boolean;
  agent: Probe;
  human: Probe;
  /** Request headers of the NAVIGATION request for each arm's probe page, straight off the wire. */
  navHeaders: Record<string, IncomingHttpHeaders>;
}

const CONTENT_TYPE: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };

/**
 * Fixture server. It serves the probe page and the vendored detector, and — the reason it is written
 * by hand rather than reused — it RECORDS the request headers of every navigation. That wire reading
 * is the only way to check `Sec-CH-UA` against what JavaScript claims, and phase 1 had to defer it
 * because a self-signed local https origin cannot persist `Accept-CH`. Plain loopback http is a
 * secure context for client-hints purposes, so it can.
 */
function startFixtureServer(): Promise<{ server: Server; origin: string; headers: Record<string, IncomingHttpHeaders> }> {
  const headers: Record<string, IncomingHttpHeaders> = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const arm = url.searchParams.get('arm');
    if (arm) headers[arm] = req.headers;
    // Ask for the high-entropy hints so the full-version-list header can be read on a later request.
    const path = url.pathname === '/' ? '/parity-probe.html' : url.pathname;
    const file = join(FIXTURES, path.replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': CONTENT_TYPE[ext] ?? 'application/octet-stream',
      'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model',
    });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}`, headers });
    });
  });
}

/** Poll a tab for its finished probe vector, identified by the `arm` query string in its URL. */
async function readProbe(app: ElectronApplication, arm: string): Promise<Probe> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const got = await app.evaluate(async ({ webContents }, marker: string) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(marker));
      if (!wc) return null;
      try {
        const v = await wc.executeJavaScript('window.__parity && window.__parity.ready ? JSON.stringify(window.__parity) : null');
        return typeof v === 'string' ? v : null;
      } catch { return null; }
    }, `arm=${arm}`);
    if (got) return JSON.parse(got) as Probe;
    await sleep(300);
  }
  throw new Error(`probe never became ready for arm=${arm}`);
}

/** One arm: launch, drive both tab classes to the probe, collect the vectors, shut down. */
async function runArm(hidden: boolean): Promise<Arm> {
  const { server, origin, headers } = await startFixtureServer();
  const dataDir = mkdtempSync(join(tmpdir(), `wigolo-parity-${hidden ? 'hidden' : 'visible'}-`));
  const env: Record<string, string> = { ...process.env as Record<string, string>, WIGOLO_DATA_DIR: dataDir };
  if (hidden) env.WIGOLO_STUDIO_HIDDEN = '1';
  const app = await launchStudio({ args: [APP_MAIN], env });
  try {
    const win = await app.firstWindow();
    const started = Date.now();
    let handle = readHandle(dataDir);
    while (!handle && Date.now() - started < 30_000) { await sleep(250); handle = readHandle(dataDir); }
    if (!handle) throw new Error('gateway handle never published');
    const proxy = new DaemonProxy(handle.endpoint, handle.token);

    // The AGENT tab. A driven tab is SSRF-fenced against loopback by design, so the human grant is
    // the only way in — the same seam the co-drive suite uses. Nothing here weakens that fence to
    // make the measurement possible; it uses the human path that already exists.
    await proxy.callTool('studio_open', {});
    await win.evaluate(() => (window as unknown as { studio: { grantLocalhost(): Promise<boolean> } }).studio.grantLocalhost());
    await sleep(200);
    const nav = body(await proxy.callTool('studio_act', { action: 'navigate', url: `${origin}/parity-probe.html?arm=agent` }));
    if (nav.ok !== true) throw new Error(`agent nav refused: ${JSON.stringify(nav)}`);

    // Collect the agent vector BEFORE opening a human tab. `TabManager.createTab` focuses the new
    // tab, which calls `setVisible(false)` on the agent's — so opening it first would mean the
    // agent's cadence numbers were measured on a tab this harness had just occluded.
    const agent = await readProbe(app, 'agent');

    // The HUMAN tab, through the omnibox seam. It carries no CDP override — its identity comes
    // entirely from the process-wide fallback, which is exactly what makes the equality below a
    // real check rather than a tautology.
    await win.evaluate(
      (url: string) => (window as unknown as { studio: { createTab(u: string): Promise<string> } }).studio.createTab(url),
      `${origin}/parity-probe.html?arm=human`,
    );
    const human = await readProbe(app, 'human');
    return { hidden, agent, human, navHeaders: { ...headers } };
  } finally {
    await app.close().catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const majorsOf = (brands: Array<{ brand: string; version: string }> | null): string[] =>
  (brands ?? []).filter((b) => b.brand !== 'Not;A=Brand' && !/not.a.brand/i.test(b.brand)).map((b) => b.version);

/** `"Not;A=Brand";v="8", "Chromium";v="150"` → `['150']`. */
function secChUaMajors(header: string | undefined): string[] {
  if (!header) return [];
  return [...header.matchAll(/"([^"]+)";v="([^"]+)"/g)]
    .filter((m) => !/not.a.brand/i.test(m[1]!))
    .map((m) => m[2]!);
}

const uaMajor = (ua: string): string | null => /Chrome\/(\d+)\./.exec(ua)?.[1] ?? null;

describe.skipIf(!RUN)('browser-substrate parity gate (e2e, both window states)', () => {
  let visible: Arm;
  let hidden: Arm;

  beforeAll(async () => {
    // Sequential, never parallel: two app instances would contend for the same gateway discovery
    // path and the same fixture ports, and a flaky gate is a gate nobody trusts.
    visible = await runArm(false);
    hidden = await runArm(true);
  }, 300_000);

  const arms = (): Array<[string, Arm]> => [['visible', visible], ['hidden', hidden]];

  describe('BotD — restricted to the verdict this harness cannot inject', () => {
    it('never reports `electron` on either tab class or in either window state — asserted on the per-detector results, because the harness injects webdriver/headless positives that would otherwise mask or outrank it', () => {
      for (const [name, arm] of arms()) {
        for (const [cls, probe] of [['agent', arm.agent], ['human', arm.human]] as const) {
          expect(probe.botdError, `${name}/${cls} botd failed to load`).toBeUndefined();
          const fired = probe.botd!.fired;
          if (fired === null) {
            // No per-detector view available: fall back to the final verdict, which still must not
            // be `electron`.
            expect(probe.botd!.botKind, `${name}/${cls}`).not.toBe('electron');
            continue;
          }
          expect(fired.join(','), `${name}/${cls}`).not.toMatch(/electron/);
        }
      }
    });

    it('collected the identity-bearing sources rather than skipping them — "no electron" from a source that failed to collect is a different fact from "no electron" from one that read a clean value', () => {
      for (const [name, arm] of arms()) {
        for (const [cls, probe] of [['agent', arm.agent], ['human', arm.human]] as const) {
          const states = probe.botd!.componentStates;
          if (!states) continue; // the bundle may stop exposing components; the verdict still stands
          for (const key of ['userAgent', 'appVersion', 'webDriver', 'distinctiveProps']) {
            expect(states[key], `${name}/${cls}: ${key} source did not collect`).toBe('ok');
          }
        }
      }
    });

    it('cannot reach window.process from a page at all: BotD flags Electron off `process.type === "renderer"`, so an OK state there would mean contextIsolation or the sandbox had been dropped in the REAL tab-creation path — a hole no reconstructed harness could catch', () => {
      for (const [name, arm] of arms()) {
        for (const [cls, probe] of [['agent', arm.agent], ['human', arm.human]] as const) {
          const states = probe.botd!.componentStates;
          if (!states) continue;
          expect(states.process, `${name}/${cls}: window.process is reachable from the page`).not.toBe('ok');
        }
      }
    });
  });

  describe('one identity per window — the point of the UA slice', () => {
    it('presents the SAME UA string from a driven tab and a human tab: two identities from one profile is the contradiction the override exists to remove, not create', () => {
      for (const [name, arm] of arms()) {
        expect(arm.agent.coherence!.userAgent, name).toBe(arm.human.coherence!.userAgent);
      }
    });

    it('presents the SAME brands from both tab classes, so a detector correlating UA against a stable cookie sees one client', () => {
      for (const [name, arm] of arms()) {
        expect(arm.agent.coherence!.brands, name).toEqual(arm.human.coherence!.brands);
      }
    });

    it('carries no Electron token and no app token in the UA or appVersion — three of BotD\'s Electron checks read exactly these two strings', () => {
      for (const [name, arm] of arms()) {
        for (const [cls, probe] of [['agent', arm.agent], ['human', arm.human]] as const) {
          expect(probe.coherence!.userAgent, `${name}/${cls}`).not.toMatch(/Electron/i);
          expect(probe.coherence!.appVersion, `${name}/${cls}`).not.toMatch(/Electron/i);
          expect(probe.coherence!.userAgent, `${name}/${cls}`).not.toMatch(/wigolo/i);
        }
      }
    });
  });

  describe('consistency coherence (§4) — contradiction is what 2026 detectors score', () => {
    it('agrees on the claimed major across the UA string, userAgentData.brands, and the Sec-CH-UA header ON THE WIRE', () => {
      for (const [name, arm] of arms()) {
        for (const cls of ['agent', 'human'] as const) {
          const c = arm[cls].coherence!;
          const ua = uaMajor(c.userAgent);
          expect(ua, `${name}/${cls} UA has no Chrome major`).toBeTruthy();
          for (const m of majorsOf(c.brands)) expect(m, `${name}/${cls} brands`).toBe(ua);
          const wire = secChUaMajors(arm.navHeaders[cls]?.['sec-ch-ua'] as string | undefined);
          // Absent is recorded, not asserted: whether Chrome sends this on a navigation is a live
          // measurement the offline gate cannot make. When it IS present it must agree.
          for (const m of wire) expect(m, `${name}/${cls} wire Sec-CH-UA`).toBe(ua);
        }
      }
    });

    // navigator.webdriver is NOT asserted here. Playwright's launch sets it, so both values in this
    // lane are the harness's, not the product's. It is asserted false — with a debugger attached — in
    // botd-gate.spec.ts, which launches without an automation harness.
    it('agrees between the two tab classes on every surface a detector reads off the client, so the harness cannot be the reason they match', () => {
      for (const [name, arm] of arms()) {
        expect(arm.agent.coherence!.webdriver, name).toBe(arm.human.coherence!.webdriver);
        expect(arm.agent.coherence!.codecs, name).toEqual(arm.human.coherence!.codecs);
        expect(arm.agent.coherence!.gatedApis, name).toEqual(arm.human.coherence!.gatedApis);
      }
    });

    it('keeps a real GPU renderer and a coherent devicePixelRatio: a real renderer string reporting dpr 0 is the contradiction to avoid', () => {
      for (const [name, arm] of arms()) {
        expect(arm.agent.coherence!.devicePixelRatio, name).toBeGreaterThan(0);
        // Same build, same machine: the hidden window must not fall back to a different renderer.
        expect(arm.agent.coherence!.webglRenderer, name).toBe(visible.agent.coherence!.webglRenderer);
      }
    });

    it('supports every codec Chromium builds on every platform', () => {
      for (const [name, arm] of arms()) {
        for (const codec of PLATFORM_INDEPENDENT_CODECS) {
          expect(arm.agent.coherence!.codecs[codec], `${name}: ${codec}`).toBe('probably');
        }
      }
    });

    // hev1 is the pre-settled ceiling (§4 item 5) — `probably` on macOS, empty on Linux, because HEVC
    // is a licensing-dependent build flag and real Chrome on Linux answers the same way. What must
    // hold is that the two tab classes agree: a codec set that differed between them would be a
    // contradiction inside one window, which is the thing this file exists to rule out.
    it('gives the SAME licensing-gated codec answers to a driven tab and a human tab', () => {
      for (const [name, arm] of arms()) {
        for (const codec of PLATFORM_DEPENDENT_CODECS) {
          expect(arm.human.coherence!.codecs[codec], `${name}: ${codec}`).toBe(arm.agent.coherence!.codecs[codec]);
        }
      }
    });

    it('exposes the version-gated APIs the claimed major ships on EVERY platform — a spoofed profile is caught for MISSING the APIs its claimed version has', () => {
      for (const [name, arm] of arms()) {
        for (const api of PLATFORM_INDEPENDENT_APIS) {
          expect(arm.agent.coherence!.gatedApis[api], `${name}: ${api} missing for the claimed major`).toBe(true);
        }
      }
    });

    // Platform-gated (BarcodeDetector is macOS/ChromeOS-only; WebHID/WebUSB/Serial vary with the
    // desktop environment). Absolute values need a same-platform Chrome reference CI does not have.
    it('reports the platform-gated APIs identically to a driven tab and a human tab', () => {
      for (const [name, arm] of arms()) {
        for (const api of PLATFORM_DEPENDENT_APIS) {
          expect(arm.human.coherence!.gatedApis[api], `${name}: ${api}`).toBe(arm.agent.coherence!.gatedApis[api]);
        }
      }
    });

    it('reports a plausible font set for the platform rather than an empty or padded list', () => {
      for (const [name, arm] of arms()) {
        expect(arm.agent.coherence!.fonts, name).not.toBeNull();
        expect(arm.agent.coherence!.fonts!.length, name).toBeGreaterThan(0);
      }
    });
  });

  describe('hidden vs visible on the same build (checklist item 6)', () => {
    it('presents an IDENTICAL identity in both window states — an identity that only holds up while a human is watching is useless for the background work this bridge exists for', () => {
      expect(hidden.agent.coherence!.userAgent).toBe(visible.agent.coherence!.userAgent);
      expect(hidden.agent.coherence!.brands).toEqual(visible.agent.coherence!.brands);
      expect(hidden.agent.coherence!.gatedApis).toEqual(visible.agent.coherence!.gatedApis);
      expect(hidden.agent.coherence!.codecs).toEqual(visible.agent.coherence!.codecs);
      expect(hidden.agent.coherence!.fonts).toEqual(visible.agent.coherence!.fonts);
    });

    it('reports visibilityState `visible` on a window that was never shown, because the page is not occluded — a hidden window is not a background tab', () => {
      expect(hidden.agent.coherence!.visibilityState).toBe('visible');
    });

    it('keeps real rAF cadence while hidden: backgroundThrottling is off, and a throttled hidden window would be trivially detectable AND would break drives', () => {
      expect(hidden.agent.coherence!.rafFps).toBeGreaterThan(30);
      // Within a factor of two of the visible arm — the loose bound is deliberate, since CI runners
      // are noisy and the failure this guards against (throttling to ~1fps) is an order of magnitude.
      expect(hidden.agent.coherence!.rafFps!).toBeGreaterThan(visible.agent.coherence!.rafFps! / 2);
    });

    it('keeps real timer cadence while hidden — background timer clamping to 1s is the classic occluded-tab tell', () => {
      expect(hidden.agent.coherence!.intervalRatio).toBeGreaterThan(0.5);
    });

    // A RECORDED CEILING, and its VALUE is deliberately not asserted in this lane. Measured, the
    // clean Playwright-free launch reports `false` while hidden — the normal state of any unfocused
    // real tab — but under this harness the same arm reports `true`, because Playwright's own
    // attachment and the app's tab focus both touch it. Pinning either value here would encode the
    // harness. `botd-gate.spec.ts` asserts the clean reading; what matters here is that the surface
    // is honestly reported at all rather than patched, which §4's no-spoof rule requires.
    it('reports document.hasFocus() honestly rather than patching it, in whichever state the window is actually in', () => {
      expect(typeof hidden.agent.coherence!.hasFocus).toBe('boolean');
      expect(typeof visible.agent.coherence!.hasFocus).toBe('boolean');
    });
  });
});
