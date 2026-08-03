/**
 * Electron main for the Playwright-FREE parity gate.
 *
 * WHY THIS EXISTS AT ALL. The Playwright-driven e2e lane cannot measure automation markers, because
 * Playwright's own launch switches set them: measured on this machine, a Playwright-launched build
 * reports `navigator.webdriver === true` and BotD returns `headless_chrome`, while the identical
 * build spawned directly reports `false` and a clean verdict. A harness that reads fingerprint
 * surfaces over CDP is measuring itself. So this script is spawned as a plain child process and the
 * probe page posts its own vector back over http — no debugger is attached to collect it.
 *
 * THIS FILE CONTAINS NO IDENTITY LOGIC, deliberately. The UA string and the client-hint metadata are
 * computed by the PRODUCTION module (`src/main/ua-identity.ts`) in the spec that spawns this, and
 * arrive as JSON in `WIGOLO_PROBE_OVERRIDE`. If they were recomputed here, the gate could pass while
 * production drifted — the failure mode that makes a re-implemented harness worse than none. What
 * production's own call SEQUENCE looks like is asserted structurally in the unit suite, and the real
 * wiring end-to-end is asserted by the Playwright lane.
 *
 * Arms (`WIGOLO_PROBE_ARM`):
 *   plain    — production tab preferences, nothing else. The NEGATIVE CONTROL: it must be flagged.
 *   identity — the shipped driven-tab condition: debugger attached, the SSRF fence's Fetch.enable
 *              armed, and the identity override applied after the about:blank load.
 */
import { app, BrowserWindow, WebContentsView } from 'electron';

const ARM = process.env.WIGOLO_PROBE_ARM || 'plain';
const HIDDEN = process.env.WIGOLO_PROBE_HIDDEN === '1';
const PROBE_URL = process.env.WIGOLO_PROBE_URL;
const BUDGET_MS = Number(process.env.WIGOLO_PROBE_BUDGET_MS || 25000);
const override = process.env.WIGOLO_PROBE_OVERRIDE ? JSON.parse(process.env.WIGOLO_PROBE_OVERRIDE) : null;
const presentation = process.env.WIGOLO_PROBE_PRESENTATION ? JSON.parse(process.env.WIGOLO_PROBE_PRESENTATION) : null;

const log = (o) => process.stderr.write(`${JSON.stringify(o)}\n`);

// The process-wide fallback: how the human's own tabs and the app shell get the same string. `plain`
// skips it so the control arm presents the substrate's native identity, Electron token included.
if (ARM === 'identity' && override) app.userAgentFallback = override.userAgent;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: false },
  });
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: false },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  const wc = view.webContents;

  let paused = 0;
  if (ARM === 'identity') {
    wc.debugger.attach('1.3');
    wc.debugger.on('message', (_e, method, params) => {
      if (method === 'Fetch.requestPaused') {
        paused += 1;
        wc.debugger.sendCommand('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      }
    });
    // The identical Document-scoped pattern drive-engine.ts arms, awaited the same way.
    await wc.debugger.sendCommand('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
    // TRAP: an Emulation command against a webContents that has never navigated never resolves.
    await wc.loadURL('about:blank');
    if (override) {
      // Applied verbatim. The hints are resolved by the spec (production reads them once from a secure
      // context — `about:blank` has no `navigator.userAgentData`, so a read here would always fail).
      await wc.debugger.sendCommand('Emulation.setUserAgentOverride', override);
    }
  }

  if (!HIDDEN) {
    win.show();
    win.focus();
  } else if (presentation) {
    // Mirrors production exactly, and the values come FROM production (see the header): a hidden
    // window is mapped and then withheld, because a never-shown one has no compositor surface and its
    // child view's frame clock stops dead.
    win.setOpacity(presentation.opacity);
    win.setIgnoreMouseEvents(presentation.ignoreMouseEvents);
    win.setSkipTaskbar(presentation.skipTaskbar);
    win.showInactive();
  }

  wc.loadURL(PROBE_URL).catch((err) => log({ load_error: String(err) }));

  // Bounded so a wedged arm cannot hang the run: report the interception count and quit.
  setTimeout(() => {
    log({ arm: ARM, hidden: HIDDEN, requests_paused: paused, final_url: wc.getURL() });
    app.quit();
  }, BUDGET_MS);
});

app.on('window-all-closed', () => app.quit());
