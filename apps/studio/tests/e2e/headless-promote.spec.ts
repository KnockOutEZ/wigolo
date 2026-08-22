import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ElectronApplication } from 'playwright';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchStudio } from './launch';
import { readHandle, DaemonProxy } from 'wigolo/studio';

// GATED (RUN_STUDIO_E2E) — launches the real Electron app, so it runs on the ubuntu CI lane under xvfb.
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');

interface ToolResult { content: Array<{ type: string; text: string }>; isError: boolean }
const body = (r: unknown) => JSON.parse((r as ToolResult).content[0].text) as Record<string, unknown>;

interface RunMenuProbe { labels(): string[]; checked(): boolean[]; click(index: number): void }
const probe = (): RunMenuProbe =>
  (globalThis as typeof globalThis & { __wigoloRunMenu: RunMenuProbe }).__wigoloRunMenu;

/**
 * Law 2, end to end in the real app: a run starts with no window, is promoted to one mid-flight from
 * the only surface a withheld run has, is demoted back, and finishes headless — with one continuous
 * event log across all three states.
 *
 * The run is created by a real agent client over the real gateway, because that is what actually
 * happens: nothing about the run knows or cares whether anyone is watching it. Promotion is driven
 * through the menu the OS is showing — the same items with the same handlers, read out of the main
 * process because no driver can click a menu bar. The assertion that matters is the WINDOW: opacity
 * and click-through are what a human either sees or does not.
 */
describe.skipIf(!RUN)('headless runs, promoted and demoted (e2e, real app)', () => {
  let app: ElectronApplication;
  let dataDir: string;
  let proxy: DaemonProxy;

  const windowState = (): Promise<{ opacity: number; visible: boolean; minimized: boolean }> =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { opacity: win.getOpacity(), visible: win.isVisible(), minimized: win.isMinimized() };
    });

  const menuLabels = (): Promise<string[]> => app.evaluate(() => (globalThis as never as { __wigoloRunMenu: { labels(): string[] } }).__wigoloRunMenu.labels());
  const menuChecked = (): Promise<boolean[]> => app.evaluate(() => (globalThis as never as { __wigoloRunMenu: { checked(): boolean[] } }).__wigoloRunMenu.checked());
  const clickMenu = (index: number): Promise<void> =>
    app.evaluate((_e, i) => (globalThis as never as { __wigoloRunMenu: { click(n: number): void } }).__wigoloRunMenu.click(i), index);

  /**
   * Per-window opacity is the mechanism this feature withholds a window with, and it is the one part
   * of it the platform can refuse: X11 honours it only under a compositing window manager, and this
   * lane runs under a bare xvfb display with none (the ceiling is recorded in `hidden-mode.ts`, where
   * the alternative — moving the window off-screen — was measured to be worse because it starves the
   * tab of frames). So the WINDOW is asserted where the platform honours it, and the state machine,
   * the events and the menu — which is what this issue actually builds — are asserted everywhere.
   */
  const WINDOW_OPACITY_HONOURED = process.platform === 'darwin';

  const settle = async (want: 'visible' | 'hidden'): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (await presented() === (want === 'visible')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`the run never became ${want}`);
  };

  /** Whether any run is being watched, read from the projection the window is driven by. */
  const presented = async (): Promise<boolean> => (await menuChecked()).some(Boolean);

  const expectWindow = async (want: 'visible' | 'hidden'): Promise<void> => {
    const state = await windowState();
    // Mapped and never minimised in BOTH states: a window with no compositor surface has no frame
    // clock, so its tabs stop painting. That claim holds on every platform.
    expect(state.visible).toBe(true);
    expect(state.minimized).toBe(false);
    if (WINDOW_OPACITY_HONOURED) expect(state.opacity).toBe(want === 'visible' ? 1 : 0);
  };

  /** The durable log, read off disk — an outside signal, and platform-independent. */
  const logTypes = async (): Promise<string[]> => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(dataDir, 'wigolo.db'), { readonly: true });
    try {
      return (db.prepare('SELECT type FROM studio_run_events ORDER BY run_id, seq').all() as Array<{ type: string }>)
        .map((r) => r.type);
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-studio-headless-'));
    // `--hidden` is the boot default this whole feature is about: no window is presented at launch.
    app = await launchStudio({ args: [APP_MAIN, '--hidden'], env: { ...process.env, WIGOLO_DATA_DIR: dataDir } });
    await app.firstWindow();
    const started = Date.now();
    let handle = readHandle(dataDir);
    while (!handle && Date.now() - started < 30_000) {
      await new Promise((r) => setTimeout(r, 250));
      handle = readHandle(dataDir);
    }
    if (!handle) throw new Error('gateway handle never published');
    proxy = new DaemonProxy(handle.endpoint, handle.token);
  });

  afterAll(async () => {
    // Bounded, then killed. This lane runs one spec file at a time in one process, so an app that
    // declines to quit does not fail this spec — it starves every spec after it, which is what a
    // 60-second hook timeout here looked like the first time: seven unrelated specs red behind one
    // leaked window. A withheld window has no human to close it, so this is its normal exit.
    try {
      await Promise.race([
        app?.close(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the app did not quit')), 15_000)),
      ]);
    } catch {
      try { app?.process().kill('SIGKILL'); } catch { /* already gone */ }
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('boots with no run and nothing presented, and says so in the menu', async () => {
    await settle('hidden');
    await expectWindow('hidden');
    expect(await menuLabels()).toEqual(['No runs']);
  });

  it('runs headless → promotes from the menu bar → demotes → finishes, on one continuous log', async () => {
    const opened = body(await proxy.callTool('studio_open', {}));
    const sessionId = opened.session_id as string;
    expect(typeof sessionId).toBe('string');

    // 1. Headless. The run exists, has a tab, and nobody is watching it.
    await expect.poll(() => menuLabels().then((l) => l.length)).toBeGreaterThan(2);
    expect((await menuLabels())[0]).toBe('1 run');
    await expectWindow('hidden');
    expect((await menuChecked())[2]).toBe(false);
    expect(await logTypes()).toEqual(['run.created', 'tab.attached']); // nothing about presentation yet
    const runId = (await menuLabels())[2].split(' · ')[0];
    expect(runId).toMatch(/^[23456789abcdefghjkmnpqrstvwxyz]{4,}$/); // the short id, as every surface shows it

    // 2. Promote — the human clicks the run in the menu bar. The window comes up around a live run.
    await clickMenu(2);
    await settle('visible');
    await expectWindow('visible');
    expect((await menuChecked())[2]).toBe(true);
    expect(await logTypes()).toEqual(['run.created', 'tab.attached', 'presentation.promoted']);

    // The tab the agent is driving is on screen, not a blank stage.
    const stage = await app.evaluate(({ BrowserWindow, webContents }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return {
        views: win.contentView.children.length,
        pages: webContents.getAllWebContents().length,
      };
    });
    expect(stage.views).toBeGreaterThan(0);

    // 3. Demote — the same item, clicked again. The window goes back to withheld and the run does not
    // notice: the agent keeps working through the gateway with nobody watching.
    await clickMenu(2);
    await settle('hidden');
    await expectWindow('hidden');
    expect((await menuChecked())[2]).toBe(false);

    const observed = body(await proxy.callTool('studio_observe', {}));
    expect(observed.trusted).toBe(false); // a real answer from a real page, with no window presented

    // 4. Finish, headless. The run leaves the live count behind it.
    expect(body(await proxy.callTool('studio_close', { session_id: sessionId })).closed).toBe(true);
    await expect.poll(() => menuLabels()).toEqual(['No runs']);
    await expectWindow('hidden');
  });

  it('records the promote and the demote in the run’s own log, in order, around its work', async () => {
    // Read the durable log straight off disk rather than out of the app: an in-app probe could only
    // ever agree with the projection that drove the window. This is the outside signal — the same rows
    // a replay, an audit or an SSE tail would serve tomorrow.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(dataDir, 'wigolo.db'), { readonly: true });
    try {
      const rows = db
        .prepare('SELECT run_id, seq, type, payload FROM studio_run_events ORDER BY run_id, seq')
        .all() as Array<{ run_id: string; seq: number; type: string; payload: string }>;
      expect(rows.length).toBeGreaterThan(0);

      const runId = rows[0].run_id;
      const mine = rows.filter((r) => r.run_id === runId);
      // Gap-free across headless → visible → headless → ended. One log, no break where the window was.
      expect(mine.map((r) => r.seq)).toEqual(mine.map((_r, i) => i + 1));

      const types = mine.map((r) => r.type);
      expect(types[0]).toBe('run.created');
      expect(types.filter((t) => t.startsWith('presentation.'))).toEqual([
        'presentation.promoted',
        'presentation.demoted',
      ]);
      // The run ended after it was demoted, and it ended headless.
      expect(types.indexOf('presentation.demoted')).toBeLessThan(types.findIndex((t) => t === 'run.completed'));
      expect(JSON.parse(mine.find((r) => r.type === 'presentation.promoted')!.payload)).toEqual({
        by: 'human',
        surface: 'tray',
      });
    } finally {
      db.close();
    }
  });
});
