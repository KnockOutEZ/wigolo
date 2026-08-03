import { _electron as electron, type ElectronApplication } from 'playwright';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StudioUnderTest } from '../../src/harness.js';

/**
 * The desktop Studio app, bound to the conformance harness.
 *
 * This file is the ONLY place in the package that knows the implementation is an Electron app, that it
 * lives in `apps/studio`, or that a human's control-reclaim and localhost grant are reachable over a
 * preload bridge. Everything the suite itself does goes through the MCP endpoint. A second
 * implementation adds a sibling of this file and reuses the suite unchanged.
 *
 * WHY AN AUTOMATION DRIVER IS SAFE HERE, given the program's own recorded trap: a Playwright-launched
 * build reports `navigator.webdriver === true` and BotD returns `headless_chrome`, so any gate that
 * reads fingerprint surfaces over an automation channel scores the harness rather than the build (which
 * is why the parity gate spawns Electron as a plain child instead). This suite reads none of those
 * surfaces. It reads the MCP wire — tool names, schemas, auth, refusal fields — none of which the
 * automation channel can influence. The driver is used ONLY to launch the app and to reach the two
 * human-side seams the wire deliberately does not expose.
 */

/**
 * Overridable so the suite can be pointed at a different build (a packaged app, or a second
 * implementation's entry) without editing the adapter. Defaults to the workspace build output.
 */
const APP_MAIN = process.env.WIGOLO_STUDIO_APP_MAIN ?? join(import.meta.dirname, '../../../../apps/studio/out/main/index.js');

/** Preload-bridge surface this adapter reaches for the human-side seams. */
interface StudioBridge {
  getState(): Promise<{ tabs: Array<{ id: string }> }>;
  reclaimDrive(tabId: string): Promise<void>;
  grantLocalhost(): Promise<boolean>;
}

/**
 * Launch with a bounded retry on the transient failures a freshly-extracted Electron binary produces
 * (`ETXTBSY` while the binary is still exec-locked, a partial install race). A genuinely broken install
 * still throws — the retry is scoped to a named error pattern, never to "it failed, try again".
 */
async function launchWithRetry(opts: Parameters<typeof electron.launch>[0]): Promise<ElectronApplication> {
  const TRANSIENT = /ETXTBSY|failed to launch|install correctly|ESRCH/i;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await electron.launch(opts);
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function electronStudioUnderTest(): StudioUnderTest {
  let app: ElectronApplication | undefined;
  let dataDir: string | undefined;

  const chromeWindow = async () => {
    if (!app) throw new Error('studio not started');
    return app.firstWindow();
  };

  return {
    name: 'apps/studio (Electron desktop Studio)',

    async start() {
      // Checked rather than left to the launcher: an absent main makes Electron exit before it opens a
      // window, and the driver then waits out the whole hook timeout with no cause reported. An
      // unbuilt app is the likeliest first-run failure, so it gets the one-line answer.
      if (!existsSync(APP_MAIN)) {
        throw new Error(`no studio build at ${APP_MAIN} — build it first (npm run build -w apps/studio), or point WIGOLO_STUDIO_APP_MAIN at one`);
      }
      dataDir = mkdtempSync(join(tmpdir(), 'wigolo-studio-contract-'));
      app = await launchWithRetry({ args: [APP_MAIN], env: { ...process.env, WIGOLO_DATA_DIR: dataDir } });
      await app.firstWindow();
      return { dataDir };
    },

    async stop() {
      await app?.close().catch(() => {});
      app = undefined;
      if (dataDir) {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ }
        dataDir = undefined;
      }
    },

    // The preload bridge IS the human's own seam — the same call the Pause button makes. Awaiting the
    // invoke means the main process has applied the flip before this resolves, so the suite needs no
    // settle sleep after it.
    async humanTakesControl() {
      const win = await chromeWindow();
      const reclaimed = await win.evaluate(async () => {
        const studio = (window as unknown as { studio: StudioBridge }).studio;
        const state = await studio.getState();
        const tab = state.tabs[0];
        if (!tab) return false;
        await studio.reclaimDrive(tab.id);
        return true;
      });
      if (!reclaimed) throw new Error('no tab to reclaim — a session was expected to be open');
    },

    async humanGrantsPrivateAddresses() {
      const win = await chromeWindow();
      await win.evaluate(() => (window as unknown as { studio: StudioBridge }).studio.grantLocalhost());
    },
  };
}
