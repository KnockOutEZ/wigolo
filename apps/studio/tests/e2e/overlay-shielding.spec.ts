import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ElectronApplication } from 'playwright';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchStudio } from './launch';
import { readHandle, DaemonProxy } from 'wigolo/studio';
import { tokenValue, type Register } from '../../src/renderer/tokens';

// GATED (RUN_STUDIO_E2E) — launches the real app and drives a real agent-held tab, so it runs on the
// ubuntu CI e2e lane under xvfb.
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');
const HOSTILE = readFileSync(join(import.meta.dirname, 'fixtures/overlay-hostile.html'), 'utf8');

interface ToolResult { content: Array<{ type: string; text: string }>; isError: boolean }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The per-tab overlay is the human's evidence that an agent is driving this tab: the highlight round
 * the element being acted on, the numbered mark chip, the ghost cursor. A page able to blank it could
 * hide exactly that — the browser's own supervision surface — which is the influence law 12 says page
 * content must never have.
 *
 * The overlay draws inside a CLOSED shadow root, but that isolates JS and selector matching, not
 * INHERITANCE: custom properties cross the boundary, and every colour and dimension the overlay draws
 * with is now one. The host is a plain `[data-wigolo-overlay]` div in the page's own tree, so a page
 * rule on it beats a `:host` rule inside the shadow tree, `all: initial` does not reset custom
 * properties, and the result renders at `0px` and fully transparent with the layout intact — a
 * failure invisible to every static gate we own and to a screenshot taken on a friendly page.
 *
 * So this asserts the RENDERED result under a page that is actively attacking it: the computed styles
 * of the overlay's own elements. Reading them means piercing a closed shadow root, which page JS and
 * ordinary locators both cannot do — the browser engine's inspection protocol can, so the overlay
 * does not have to ship a test-only hook to be testable.
 *
 * The tab is the AGENT-held session tab, because that is the only tab that carries the overlay at all
 * (the human's own omnibox tabs do not — a separate, filed gap). It cannot be navigated: the fence
 * blocks `file://`, so the hostile page is injected into its `about:blank` exactly as
 * `marking.spec.ts` does, which leaves the fence untouched and still gives the overlay a real page
 * with real page CSS above it.
 *
 * It also carries the overlay's first rendered light-register assertion. The overlay is the one
 * surface that resolves its register from `prefers-color-scheme` rather than the chrome's
 * `[data-register]` (A214 — it lands on a page with no attribute of ours), so nothing in
 * `register.spec.ts` covers it.
 */
describe.skipIf(!RUN)('the per-tab overlay resists a page that tries to blank it (e2e)', () => {
  let app: ElectronApplication;
  let dataDir: string;
  let transparent: string;

  /**
   * The computed style of one overlay element, named by its class inside the CLOSED shadow root.
   *
   * The app has already attached this tab's debugger (the drive engine owns it), so this rides the
   * existing session rather than competing for it. The document is re-fetched per call: `pierce` is
   * what makes the closed root visible at all, and a cached node id would answer from before whatever
   * the test just changed.
   */
  const computedIn = (scope: 'shadow' | 'page', cls: string): Promise<Record<string, string>> =>
    app.evaluate(async ({ webContents }, arg) => {
      const wc = webContents.getAllWebContents().find((w) => {
        const u = w.getURL();
        return u === '' || u === 'about:blank';
      });
      if (!wc) throw new Error('no agent session tab');
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('DOM.enable');
      await wc.debugger.sendCommand('CSS.enable');
      interface N { nodeId: number; attributes?: string[]; children?: N[]; shadowRoots?: N[] }
      const { root } = (await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true })) as { root: N };
      const attrs = (n: N): Record<string, string> => {
        const out: Record<string, string> = {};
        const a = n.attributes ?? [];
        for (let i = 0; i + 1 < a.length; i += 2) out[a[i]] = a[i + 1];
        return out;
      };
      const walk = (n: N, hit: (n: N) => boolean): N | null => {
        if (hit(n)) return n;
        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
          const found = walk(c, hit);
          if (found) return found;
        }
        return null;
      };
      let from = root;
      if (arg.scope === 'shadow') {
        const host = walk(root, (n) => 'data-wigolo-overlay' in attrs(n));
        if (!host) throw new Error('the overlay host is not in the page at all');
        const shadow = host.shadowRoots?.[0];
        if (!shadow) throw new Error('the overlay host has no shadow root the protocol can see');
        from = shadow;
      }
      const el = walk(from, (n) => (attrs(n).class ?? '').split(/\s+/).includes(arg.cls));
      if (!el) throw new Error(`.${arg.cls} is not in the ${arg.scope}`);
      const { computedStyle } = (await wc.debugger.sendCommand('CSS.getComputedStyleForNode', {
        nodeId: el.nodeId,
      })) as { computedStyle: Array<{ name: string; value: string }> };
      return Object.fromEntries(computedStyle.map((p) => [p.name, p.value])) as Record<string, string>;
    }, { scope, cls });

  /**
   * A declared value put through the SAME reader the overlay's own styles go through, so the two are
   * comparable. It has to be the same reader: the protocol serializes a colour as `oklab(…)` while
   * `getComputedStyle` in page script serializes the identical colour as `oklch(…)`, and a test that
   * mixed the two would fail on spelling rather than on colour.
   *
   * The value is derived from `tokens.ts` — the source of truth — and never from the overlay, so an
   * overlay that is wrong but self-consistent cannot satisfy it. It is set inline on a throwaway
   * element in the page, which no custom property of the page can reach.
   */
  const asComputed = async (property: string, value: string): Promise<string> => {
    await app.evaluate(async ({ webContents }, arg) => {
      const wc = webContents.getAllWebContents().find((w) => {
        const u = w.getURL();
        return u === '' || u === 'about:blank';
      });
      if (!wc) throw new Error('no agent session tab');
      await wc.executeJavaScript(
        `(function(){var old=document.querySelector('.wigolo-token-probe');if(old)old.remove();` +
        `var p=document.createElement('span');p.className='wigolo-token-probe';` +
        `p.style.setProperty(${JSON.stringify(arg.property)},${JSON.stringify(arg.value)});` +
        `document.body.appendChild(p);return true;})()`,
      );
    }, { property, value });
    return (await computedIn('page', 'wigolo-token-probe'))[property];
  };

  /**
   * The colour-scheme preference this tab resolves against — the overlay's only register input.
   *
   * Emulated per tab rather than set through `nativeTheme.themeSource`: the process-wide theme source
   * does not move `prefers-color-scheme` inside a WebContentsView (measured — the overlay stayed on
   * the host machine's register through both settings), and a register test driven by an input that
   * does nothing would pass in exactly one register and call it two. This is the same command
   * `page.emulateMedia({ colorScheme })` issues.
   */
  const emulateRegister = (register: Register): Promise<void> =>
    app.evaluate(async ({ webContents }, r) => {
      const wc = webContents.getAllWebContents().find((w) => {
        const u = w.getURL();
        return u === '' || u === 'about:blank';
      });
      if (!wc) throw new Error('no agent session tab');
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: r }],
      });
    }, register);

  /**
   * The settled computed style of an overlay element.
   *
   * The highlight carries a 60ms transition, so a read taken straight after arming, marking or a
   * register switch can catch a frame mid-blend: a real colour that is neither the old one nor the new
   * one, and one that drifts with machine load. Two consecutive agreeing samples mean the animation is
   * over — which is also what a human looking at the screen would be judging.
   */
  const stable = async (cls: string): Promise<Record<string, string>> => {
    const shape = (s: Record<string, string>): string =>
      JSON.stringify([s.display, s['border-top-width'], s['border-top-color'], s['background-color'], s.color]);
    let prev = await computedIn('shadow', cls);
    for (let i = 0; i < 100; i++) {
      await sleep(80);
      const next = await computedIn('shadow', cls);
      if (shape(next) === shape(prev)) return next;
      prev = next;
    }
    throw new Error(`.${cls} never stopped animating`);
  };

  /** Hand-rolled rather than `expect.poll`, which refuses to run from `beforeAll`. */
  const settle = async (want: () => Promise<boolean>, what: string): Promise<void> => {
    let last = '';
    for (let i = 0; i < 100; i++) {
      try {
        if (await want()) return;
      } catch (err) {
        last = String(err); // the element may not exist yet — not-ready, not a failure
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` — last: ${last}` : ''}`);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-studio-overlay-e2e-'));
    app = await launchStudio({ args: [APP_MAIN], env: { ...process.env, WIGOLO_DATA_DIR: dataDir } });
    await app.firstWindow();

    const started = Date.now();
    let handle = readHandle(dataDir);
    while (!handle && Date.now() - started < 30_000) { await sleep(250); handle = readHandle(dataDir); }
    if (!handle) throw new Error('gateway handle never published');
    // `studio_open` is what mints the agent-held tab, and that tab is the only one carrying the overlay.
    const proxy = new DaemonProxy(handle.endpoint, handle.token);
    const opened = JSON.parse((await proxy.callTool('studio_open', {}) as ToolResult).content[0].text) as { session_id?: string };
    if (typeof opened.session_id !== 'string') throw new Error('studio_open did not return a session');
    // Pinned, not assumed: the host machine's own register would otherwise decide which half of this
    // spec is the real assertion and which is a no-op.
    await emulateRegister('dark');

    // Inject the hostile page and drive the overlay with REAL input: hold Alt to arm, move onto the
    // target to draw the highlight, press to commit the mark that mints the chip. Alt stays held —
    // releasing it disarms the overlay.
    const armed = await app.evaluate(async ({ webContents }, arg) => {
      const wc = webContents.getAllWebContents().find((w) => {
        const u = w.getURL();
        return u === '' || u === 'about:blank';
      });
      if (!wc) {
        return { ok: false as const, seen: webContents.getAllWebContents().map((w) => ({ type: w.getType(), url: w.getURL() })) };
      }
      // Into `body`, not `documentElement`: the overlay host hangs off `documentElement`, and the
      // parser keeps the fixture's `<style>` while dropping its document wrapper.
      await wc.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(arg.page)}; true`);
      const r = (await wc.executeJavaScript(
        `(function(){var b=document.getElementById('target').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};})()`,
      )) as { x: number; y: number; w: number; h: number };
      const at = { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
      wc.focus();
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Alt', modifiers: ['alt'] });
      wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y, modifiers: ['alt'] });
      return { ok: true as const, at };
    }, { page: HOSTILE });
    if (!armed.ok) throw new Error('no agent session tab; webContents = ' + JSON.stringify(armed.seen));

    await settle(async () => (await computedIn('shadow', 'outline')).display === 'block', 'the highlight to be drawn');

    await app.evaluate(({ webContents }, at) => {
      const wc = webContents.getAllWebContents().find((w) => {
        const u = w.getURL();
        return u === '' || u === 'about:blank';
      })!;
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
    }, armed.at);

    await settle(async () => { await computedIn('shadow', 'chip'); return true; }, 'the mark chip to be minted');
    // What the fixture asked every one of those tokens to be, spelled the way this reader spells it.
    transparent = await asComputed('color', 'transparent');
  });

  afterAll(async () => {
    await app?.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('draws the highlight at its token values though the page redeclared every one of them', async () => {
    // With the token layer declared on `:host`, this exact fixture renders the highlight as a border of
    // no width and no colour over a background of no colour — nothing at all — while `display: block`
    // still reports the overlay as shown. That is the shape of the regression: it does not throw, it
    // does not move anything, and it leaves a screenshot that looks like a page with no agent on it.
    const outline = await stable('outline');
    expect(outline.display).toBe('block');
    expect(outline['border-top-width']).toBe(tokenValue('--hair-width', 'dark'));
    expect(outline['border-top-color']).toBe(await asComputed('border-top-color', tokenValue('--agent', 'dark')));
    // `.marked` is on the outline by now (the mark was committed in setup), so the strong tint is the
    // one in force.
    expect(outline['background-color']).toBe(await asComputed('background-color', tokenValue('--agent-tint-strong', 'dark')));
    // Named separately from the equalities above so a regression reads as "the page won" rather than as
    // an opaque string mismatch: these are the exact values the fixture asked for.
    expect(outline['border-top-width']).not.toBe('0px');
    expect(outline['border-top-color']).not.toBe(transparent);
    expect(outline['background-color']).not.toBe(transparent);
  });

  it('draws the mark chip — the shared address space — at its token values', async () => {
    // Law 8: the same number appears on the page, in chat, in the terminal and in the replay. A page
    // that can blank the on-page end of that breaks the address space for the human and for nobody
    // else, which is precisely the asymmetry worth attacking.
    const chip = await stable('chip');
    expect(chip['background-color']).toBe(await asComputed('background-color', tokenValue('--mark-bg', 'dark')));
    expect(chip.color).toBe(await asComputed('color', tokenValue('--agent-text', 'dark')));
    expect(chip['border-top-width']).toBe(tokenValue('--hair-width', 'dark'));
    expect(chip['background-color']).not.toBe(transparent);
    expect(chip.color).not.toBe(transparent);
  });

  it('renders its light register, resolved from the system preference and not from the chrome', async () => {
    // The overlay's first RENDERED register assertion. Every other register test reads the chrome
    // window, which switches on `[data-register]`; the overlay has no such attribute available to it
    // and keys on `prefers-color-scheme` instead, so the chrome's coverage says nothing about it. The
    // switch is driven through the OS signal the app really listens to, not by poking the overlay.
    //
    // `--mark-bg` inverts outright between the registers (#000 → #fff), which makes it the one token
    // where "the light block never matched" and "the light block matched" cannot look alike.
    const darkChip = await stable('chip');
    await emulateRegister('light');

    const lightChip = await stable('chip');
    expect(lightChip['background-color']).toBe(await asComputed('background-color', tokenValue('--mark-bg', 'light')));
    expect(lightChip['background-color']).not.toBe(darkChip['background-color']);
    expect(lightChip.color).toBe(await asComputed('color', tokenValue('--agent-text', 'light')));
    // Still shielded in the light register. The fixture's rule is register-agnostic, so a fix that
    // covered only the dark block would surface here and nowhere else.
    const lightOutline = await stable('outline');
    expect(lightOutline['border-top-color']).toBe(await asComputed('border-top-color', tokenValue('--agent', 'light')));
    expect(lightOutline['border-top-width']).toBe(tokenValue('--hair-width', 'light'));
    expect(lightOutline['border-top-color']).not.toBe(transparent);

    await emulateRegister('dark');
  });
});
