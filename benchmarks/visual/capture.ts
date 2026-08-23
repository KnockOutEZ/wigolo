/**
 * L-DET capture — real pages, through the SHIPPED harvest, frozen to disk as geometry.
 *
 *   npx tsx benchmarks/visual/capture.ts [--ref 1280] [--alt 1024] [--out <path>]
 *
 * WHY THIS EXISTS. `synth.ts:14-18` forbids reading a G-S11a verdict out of the synthetic corpus,
 * and it is right to: synthetic input measures the metric's arithmetic and nothing about the web.
 * The blocker it names is licensing a page corpus. This captures GEOMETRY ONLY — box rectangles and
 * per-box text LENGTHS — so no third-party content is stored and that blocker does not apply
 * (`urls.ts:4-12`).
 *
 * WHY IT DRIVES `harvestLayout` RATHER THAN READING RECTS ITSELF. A corpus captured by a second,
 * convenient path measures that path, not the product. The gate has to be scored on what the
 * product actually sees, including its unit convention, its main-document-only rule and its
 * clamping — so the capture injects the browser engine's debug session as the harvest's transport
 * and stores whatever comes back. The round-trip count is COUNTED on that injected transport at the
 * same time, which is G-S11a-2's outside signal measured on real pages instead of a fake one.
 *
 * The two reference renders are two INDEPENDENT page loads. A same-page pair has to survive real
 * re-render noise — a rotating ad slot, a lazily-loaded image shifting the fold, a consent banner,
 * a late font — and re-signing one capture twice would measure none of it.
 */
import { chromium, type Browser } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { harvestLayout, type LayoutCdp } from '../../src/studio/layout/harvest.js';
import {
  CORPUS_PATH,
  writeCorpus,
  type CapturedPage,
  type CapturedRender,
  type FrozenCorpus,
  type RenderKind,
} from './corpus.js';
import { allSeedUrls, groupOf } from './urls.js';

/** The width every reference render is laid out at. */
export const REF_WIDTH = 1280;
/**
 * The SECOND viewport width, and it is part of the gate definition rather than an implementation
 * detail — see `gate.ts`'s clause-2 section for the measurement the number was chosen from.
 */
export const ALT_WIDTH = 1024;
/**
 * Every width the alternate render is captured at.
 *
 * The gate is scored at ONE of these — `ALT_WIDTH` — and the rest exist so that number is a CHOICE
 * with evidence under it rather than a constant someone liked. The old runner's verdict swung from
 * 100% to 30% across this range on synthetic pages (`known-issues.md` P4) with nothing in the spec
 * naming which width was meant, so the sweep is captured once and the pin is argued from it.
 */
export const ALT_WIDTH_SWEEP = [1152, 1024, 900, 720];
export const VIEWPORT_HEIGHT = 900;

const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 1200;
const CONCURRENCY = 4;

interface RenderPlan {
  kind: RenderKind;
  width: number;
  dsf: number;
}

function plan(refWidth: number, altWidths: number[]): RenderPlan[] {
  return [
    { kind: 'ref_a', width: refWidth, dsf: 1 },
    { kind: 'ref_b', width: refWidth, dsf: 1 },
    ...altWidths.map((w): RenderPlan => ({ kind: 'alt_width', width: w, dsf: 1 })),
    { kind: 'dpr2', width: refWidth, dsf: 2 },
  ];
}

async function captureOne(browser: Browser, url: string, p: RenderPlan): Promise<CapturedRender> {
  const ctx = await browser.newContext({
    viewport: { width: p.width, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: p.dsf,
    // A real user agent, because a page served its no-JS or bot variant is a different LAYOUT, and
    // the corpus would then be measuring our own fetch signature rather than the page.
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    // Let late layout settle — web fonts and lazily inserted banners move boxes after `load`, and a
    // capture taken before they land is noise the gate would attribute to the metric.
    await page.waitForTimeout(SETTLE_MS);
    const session = await ctx.newCDPSession(page);
    let sends = 0;
    const cdp: LayoutCdp = {
      send: (method, params) => {
        sends++;
        return session.send(method as Parameters<typeof session.send>[0], params as never) as Promise<unknown>;
      },
    };
    const t0 = performance.now();
    const result = await harvestLayout(cdp);
    const harvestMs = performance.now() - t0;
    if (!result.ok) throw new Error(`harvest ${result.reason}`);
    return {
      kind: p.kind,
      viewportWidth: p.width,
      deviceScaleFactor: p.dsf,
      input: result.input,
      sends,
      harvestMs,
    };
  } finally {
    await ctx.close();
  }
}

async function capturePage(browser: Browser, url: string, plans: RenderPlan[]): Promise<CapturedPage> {
  const renders: CapturedRender[] = [];
  for (const p of plans) renders.push(await captureOne(browser, url, p));
  return { url, group: groupOf(url), renders };
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const refWidth = Number(arg('ref', String(REF_WIDTH)));
  const altWidths = arg('alts', ALT_WIDTH_SWEEP.join(',')).split(',').map(Number).filter((n) => n > 0);
  const out = arg('out', CORPUS_PATH);
  const urls = allSeedUrls();
  const plans = plan(refWidth, altWidths);

  const browser = await chromium.launch();
  const pages: CapturedPage[] = [];
  const failures: Array<{ url: string; reason: string }> = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      const url = urls[i];
      try {
        const captured = await capturePage(browser, url, plans);
        pages.push(captured);
        process.stderr.write(`  ok   ${captured.renders[0].input.boxes.length.toString().padStart(6)} boxes  ${url}\n`);
      } catch (e) {
        const reason = (e as Error).message.split('\n')[0].slice(0, 120);
        failures.push({ url, reason });
        process.stderr.write(`  FAIL ${url} — ${reason}\n`);
      }
    }
  };

  process.stderr.write(`capturing ${urls.length} seeds x ${plans.length} renders at ref=${refWidth} alts=${altWidths.join(',')}\n`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const version = browser.version();
  await browser.close();

  pages.sort((a, b) => a.url.localeCompare(b.url)); // stable order regardless of which worker finished first
  const corpus: FrozenCorpus = {
    version: 1,
    provenance: {
      capturedAt: new Date().toISOString(),
      browserEngine: 'chromium',
      browserVersion: version,
      platform: `${process.platform}-${process.arch}`,
      refWidth,
      altWidth: ALT_WIDTH,
      altWidthSweep: altWidths,
      viewportHeight: VIEWPORT_HEIGHT,
      attempted: urls.length,
      failures,
    },
    pages,
  };
  mkdirSync(dirname(out), { recursive: true });
  const bytes = writeCorpus(corpus, out);
  process.stderr.write(
    `\ncaptured ${pages.length}/${urls.length} pages, ${failures.length} failed — ${(bytes / 1024).toFixed(0)} KiB gzipped at ${out}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`capture failed: ${(e as Error).stack}\n`);
  process.exitCode = 1;
});
