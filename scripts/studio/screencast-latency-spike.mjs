#!/usr/bin/env node
/*
 * Studio Phase 1 — Task 1 GATE: screencast latency spike.
 *
 * Measures the input-to-paint round-trip of the BASELINE transport
 * (CDP Page.startScreencast -> JPEG-over-WS -> canvas) before the screencast
 * bridge (slice 1b) is built, so the verdict shapes the bridge instead of the
 * bridge assuming a transport. Mirrors the Phase-0 ONNX isolation spike: it
 * reports numbers + a GO/SURFACE verdict; it is not the production code.
 *
 * Pipeline under test (one trip):
 *   node dispatches a CDP Input event  (t0)
 *     -> Chrome runs the page handler, which TOGGLES a fixed corner __spikeSwatch
 *        black<->red(220) and repaints
 *     -> Page.screencastFrame (jpeg, base64) fires to node
 *     -> node forwards the frame as a JSON WS message to a headless viewer page
 *     -> viewer decodes the JPEG, drawImage()s it, samples the __spikeSwatch pixel,
 *        and acks the red value
 *     -> node receives the ack  (t1)
 *   round-trip = t1 - t0  (~= input-to-paint + a sub-ms loopback ack leg;
 *   slightly conservative, which is what we want for a gate).
 *
 * Robustness: the __spikeSwatch TOGGLES (220 vs 0) rather than encoding a sequence
 * number, so JPEG quantization can't corrupt the marker; serial dispatch
 * (wait-for-paint-or-timeout before the next input) pairs each input with its
 * painted frame without any counter sync.
 *
 * Env:
 *   SPIKE_HEADLESS=1   run the session browser headless (default: headed,
 *                      matching the production session-browser default)
 *   SPIKE_QUALITY=60   JPEG quality passed to startScreencast
 *   SPIKE_N=30         interactions per type (click/type/scroll)
 *
 * Usage: node scripts/studio/screencast-latency-spike.mjs
 */
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SESSION_HEADLESS = process.env.SPIKE_HEADLESS === '1';
const SPIKE_URL = process.env.SPIKE_URL || null;
const QUALITY = Number(process.env.SPIKE_QUALITY ?? 60);
const W = 1280;
const H = 720;
const N = Number(process.env.SPIKE_N ?? 30);
const INPUT_TIMEOUT_MS = 3000;
const RED_ON = 220;
const RED_THRESHOLD = 110;

const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  body{height:1200vh;background:repeating-linear-gradient(0deg,#111 0 40px,#333 40px 80px)}
  #__spikeSwatch{position:fixed;top:0;left:0;width:60px;height:60px;background:rgb(0,0,0);z-index:10}
  #inp{position:fixed;top:0;left:80px;z-index:10}
</style></head><body>
  <div id="__spikeSwatch"></div>
  <input id="inp" autofocus>
  <script>
    window.__on=false;
    var sw=document.getElementById('__spikeSwatch');
    function bump(){ window.__on=!window.__on; sw.style.background = window.__on ? 'rgb(${RED_ON},0,0)' : 'rgb(0,0,0)'; }
    document.addEventListener('pointerdown',bump,true);
    document.addEventListener('keydown',bump,true);
    document.addEventListener('wheel',bump,{passive:true,capture:true});
  </script>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
const median = (a) => pct(a, 50);
const fmt = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(1));

async function waitFor(pred, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function main() {
  // --- WS server (host side) ---
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;

  let viewer = null;
  const acks = []; // { red, t }
  let countWindow = false;
  let windowFrames = 0;
  let frameCount = 0;
  let frameB64Bytes = 0;

  wss.on('connection', (ws) => {
    viewer = ws;
    ws.on('message', (buf) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === 'ack') acks.push({ red: m.seq, t: performance.now() });
    });
  });

  // Resolve when an ack arrives (after t0) whose __spikeSwatch state matches `on`.
  async function waitForState(on, t0) {
    const deadline = performance.now() + INPUT_TIMEOUT_MS;
    let idx = acks.length; // only consider acks observed after dispatch
    while (performance.now() < deadline) {
      for (; idx < acks.length; idx++) {
        const rec = acks[idx];
        if (rec.t >= t0 && rec.red > RED_THRESHOLD === on) return rec.t;
      }
      await sleep(2);
    }
    return null;
  }

  // --- session browser + page ---
  const sessionBrowser = await chromium.launch({ headless: SESSION_HEADLESS });
  const sctx = await sessionBrowser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const spage = await sctx.newPage();
  if (SPIKE_URL) {
    // Real content page: navigate, then inject the toggle __spikeSwatch + input
    // listeners over the page's own DOM. page.evaluate runs via CDP, so it is
    // not subject to the page's CSP. The page's real content drives frame size
    // + repaint cadence; the injected __spikeSwatch is the input marker.
    await spage.goto(SPIKE_URL, { waitUntil: 'load', timeout: 30000 });
    await spage.evaluate((RED) => {
      const root = document.body || document.documentElement;
      let sw = document.getElementById('__spikeSwatch');
      if (!sw) {
        sw = document.createElement('div');
        sw.id = '__spikeSwatch';
        root.appendChild(sw);
      }
      sw.style.cssText =
        'position:fixed;top:0;left:0;width:60px;height:60px;background:rgb(0,0,0);z-index:2147483647;pointer-events:none';
      window.__on = false;
      const bump = () => {
        window.__on = !window.__on;
        const s = document.getElementById('__spikeSwatch');
        if (s) s.style.background = window.__on ? `rgb(${RED},0,0)` : 'rgb(0,0,0)';
      };
      document.addEventListener('pointerdown', bump, true);
      document.addEventListener('keydown', bump, true);
      document.addEventListener('wheel', bump, { passive: true, capture: true });
    }, RED_ON);
  } else {
    await spage.setContent(TEST_PAGE);
  }

  const cdp = await sctx.newCDPSession(spage);
  cdp.on('Page.screencastFrame', async (f) => {
    frameCount++;
    frameB64Bytes += f.data.length;
    if (countWindow) windowFrames++;
    if (viewer && viewer.readyState === 1) viewer.send(JSON.stringify({ t: 'frame', data: f.data }));
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });

  // --- viewer browser (always headless: just decodes + paints + samples) ---
  const viewerBrowser = await chromium.launch({ headless: true });
  const vpage = await (await viewerBrowser.newContext()).newPage();
  await vpage.goto('file://' + join(__dirname, 'viewer.html') + '?port=' + port);
  await waitFor(() => viewer && viewer.readyState === 1, 5000, 'viewer WS connect');

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

  // Settle + force a known baseline (__spikeSwatch off).
  await sleep(600);
  await spage.evaluate(() => { window.__on = false; const s = document.getElementById('__spikeSwatch'); if (s) s.style.background = 'rgb(0,0,0)'; });
  await sleep(300);

  const cx = Math.floor(W / 2);
  const cy = Math.floor(H / 2);
  let expectedOn = false;

  async function oneInput(dispatch) {
    const t0 = performance.now();
    expectedOn = !expectedOn;
    await dispatch();
    const tPaint = await waitForState(expectedOn, t0);
    return tPaint == null ? null : tPaint - t0;
  }

  const clickFn = async () => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
  };
  const typeFn = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  };
  let wheelDir = 1;
  const scrollFn = async () => {
    wheelDir = -wheelDir;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 120 * wheelDir });
  };

  const results = { click: [], type: [], scroll: [] };
  const missed = { click: 0, type: 0, scroll: 0 };

  for (const [name, fn] of [['click', clickFn], ['type', typeFn], ['scroll', scrollFn]]) {
    expectedOn = await spage.evaluate(() => !!window.__on); // resync to page truth
    for (let k = 0; k < N; k++) {
      const rtt = await oneInput(fn);
      if (rtt == null) missed[name]++;
      else results[name].push(rtt);
      await sleep(80);
    }
  }

  // --- cadence under a sustained scroll burst (frame-rate stress) ---
  const burstMs = 2000;
  windowFrames = 0;
  countWindow = true;
  const burstStart = performance.now();
  let bd = 1;
  while (performance.now() - burstStart < burstMs) {
    bd = -bd;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 200 * bd });
    await sleep(16);
  }
  await sleep(150);
  countWindow = false;
  const burstElapsed = (performance.now() - burstStart) / 1000;
  const cadenceFps = windowFrames / burstElapsed;

  // --- report ---
  const avgB64 = frameCount ? frameB64Bytes / frameCount : 0;
  const avgDecodedKB = (avgB64 * 0.75) / 1024;

  const line = (name) => {
    const a = results[name];
    const max = a.length ? Math.max(...a) : NaN;
    return `  ${name.padEnd(7)} n=${String(a.length).padStart(2)} (miss ${missed[name]})  median ${fmt(median(a)).padStart(6)} ms   p95 ${fmt(pct(a, 95)).padStart(6)} ms   max ${fmt(max).padStart(6)} ms`;
  };

  const worstMed = Math.max(median(results.click), median(results.type), median(results.scroll));
  const worstP95 = Math.max(pct(results.click, 95), pct(results.type, 95), pct(results.scroll, 95));
  let verdict;
  if (worstMed < 150 && worstP95 < 300 && cadenceFps >= 10) verdict = 'GO (baseline JPEG-over-WS holds)';
  else if (worstMed > 300 || cadenceFps < 5) verdict = 'SURFACE (baseline transport insufficient)';
  else verdict = 'GRAY ZONE — report numbers, CEO decides';

  console.log('\n================ Studio Phase-1 screencast latency spike ================');
  console.log(`  page: ${SPIKE_URL ?? 'synthetic striped test page'}`);
  console.log(`  session browser: ${SESSION_HEADLESS ? 'headless' : 'headed'}   viewer: headless   jpeg q=${QUALITY}   ${W}x${H}   N=${N}/type`);
  console.log('  input-to-paint round-trip (lower = better):');
  console.log(line('click'));
  console.log(line('type'));
  console.log(line('scroll'));
  console.log(`  scroll-burst cadence: ${cadenceFps.toFixed(1)} fps  (${windowFrames} frames / ${burstElapsed.toFixed(2)}s)`);
  console.log(`  frame size: ~${avgDecodedKB.toFixed(1)} KB decoded (~${(avgB64 / 1024).toFixed(1)} KB base64-in-JSON on the wire)   total frames: ${frameCount}`);
  console.log(`  worst-of-type: median ${fmt(worstMed)} ms   p95 ${fmt(worstP95)} ms`);
  console.log(`  VERDICT: ${verdict}`);
  console.log('=========================================================================\n');

  // --- cleanup ---
  try { await cdp.send('Page.stopScreencast'); } catch {}
  await viewerBrowser.close().catch(() => {});
  await sessionBrowser.close().catch(() => {});
  await new Promise((r) => wss.close(r));
}

const guard = setTimeout(() => { console.error('spike: overall timeout (120s) — aborting'); process.exit(2); }, 120000);
guard.unref();

main().then(() => process.exit(0)).catch((err) => {
  console.error('spike failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
