/**
 * S12-0 — the C0 LIVE-DOM lane.
 *
 * The frozen lane reads a string off disk and hands it to the extractor. That cannot score
 * anything that only exists once a page is RENDERED: computed visibility, a collapsed
 * <details>, an off-screen tab panel, a script-built table. Every S12 go/no-go is read off a
 * rendered page, so the referee needs a lane that renders one.
 *
 * Determinism is preserved by construction: the bytes served are the SAME frozen fixture
 * bytes the blocking lane uses, served from LOOPBACK. There is no network and no third-party
 * site in the loop, so the live lane is as CI-eligible as the frozen one; only the RENDERING
 * is live.
 *
 * Both lanes are scored by the same `evaluateAssertion`, from the same manifest, in the same
 * process, in the same run — the base-vs-tip differential discipline. A comparison drawn
 * across two runs on two machines proves nothing about the extractor.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SessionDrive } from '../../src/studio/session-drive.js';
import { assertionKey, summarise } from './score.js';
import { runFixture } from './runner.js';
import type { FixtureResult, ScrapeManifest, ScrapeReport } from './types.js';

/**
 * A seeded regression, applied to the SERVED BYTES before the browser ever sees them.
 *
 * This is the lane's inversion probe, and it is deliberately upstream of the reader: it
 * removes the CAPABILITY (the tables are genuinely not in the DOM), not an artifact of it.
 * A probe that stubbed the scorer, or deleted an expectation, would be satisfied by a
 * blinded detector and prove nothing.
 */
export type LiveSeed = 'none' | 'strip_tables' | 'strip_headings' | 'strip_body';

export function applySeed(html: string, seed: LiveSeed): string {
  switch (seed) {
    case 'none':
      return html;
    case 'strip_tables':
      return html.replace(/<table\b[\s\S]*?<\/table>/gi, '');
    case 'strip_headings':
      return html.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, '');
    case 'strip_body':
      return html.replace(/<body\b[^>]*>[\s\S]*<\/body>/i, '<body></body>');
  }
}

export interface FixtureServer {
  /** e.g. `http://127.0.0.1:53124` */
  origin: string;
  close(): Promise<void>;
}

/**
 * Serve a fixed set of fixture documents from loopback.
 *
 * The served set is an ALLOW-LIST built from the manifest, keyed by `htmlPath`, and the
 * request path is only ever used as a MAP KEY — never joined onto a filesystem path. A
 * traversal request therefore cannot escape the corpus because there is no filesystem lookup
 * to escape into; it simply misses the map and 404s.
 */
export async function serveFixtures(documents: Map<string, string>): Promise<FixtureServer> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const key = decodeURIComponent((req.url ?? '/').split('?')[0]!.replace(/^\/+/, ''));
    const body = documents.get(key);
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such fixture');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A reader for the live lane.
 *
 * `readCurrentPage` is typed as the PRODUCTION seam (`SessionDrive['readCurrentPage']`, the
 * one `runSessionExtract` and `studio_fetch` call), so the compiler — not a comment — is what
 * holds the lane to the shape production reads through. If that seam's contract changes, this
 * file stops compiling.
 */
export interface LivePageReader extends Pick<SessionDrive, 'readCurrentPage'> {
  goto(url: string): Promise<void>;
  close(): Promise<void>;
}

/** Launch a real browser and drive it. Used by the CLI; unit tests inject a fake instead. */
export async function createBrowserReader(): Promise<LivePageReader> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  return {
    goto: async (url: string) => {
      await page.goto(url, { waitUntil: 'load' });
    },
    readCurrentPage: async () => ({ url: page.url(), html: await page.content() }),
    close: async () => {
      await browser.close();
    },
  };
}

export interface LiveLaneOptions {
  manifest: ScrapeManifest;
  htmlDir: string;
  reader: LivePageReader;
  seed?: LiveSeed;
  filter?: string;
}

/**
 * Render every fixture and score it.
 *
 * The extractor is handed `fixture.url` — the REAL url — not the loopback url, so site rules
 * (`github.com`, `wikipedia.org`) apply exactly as they do on the frozen lane. Loopback is
 * transport for the bytes, never the identity of the document.
 */
export async function runLiveLane(opts: LiveLaneOptions): Promise<ScrapeReport> {
  const t0 = Date.now();
  const fixtures = opts.filter
    ? opts.manifest.fixtures.filter((f) => f.id.includes(opts.filter!) || f.pageClass === opts.filter)
    : opts.manifest.fixtures;
  if (fixtures.length === 0) throw new Error(`no fixtures match filter "${opts.filter}"`);

  const documents = new Map<string, string>();
  for (const f of fixtures) {
    const path = join(opts.htmlDir, f.htmlPath);
    // Same hard-error-on-missing rule as the frozen lane. A skip-on-missing live lane would
    // reproduce exactly the rot the frozen lane's comment describes.
    if (!existsSync(path)) throw new Error(`fixture snapshot missing: ${path} (referenced by ${f.id})`);
    documents.set(f.htmlPath, applySeed(readFileSync(path, 'utf-8'), opts.seed ?? 'none'));
  }

  const server = await serveFixtures(documents);
  const results: FixtureResult[] = [];
  try {
    for (const f of fixtures) {
      await opts.reader.goto(`${server.origin}/${f.htmlPath}`);
      const page = await opts.reader.readCurrentPage();
      results.push(await runFixture(f, page.html));
    }
  } finally {
    await server.close();
  }
  return summarise(results, Date.now() - t0, new Date().toISOString());
}

/**
 * Page classes whose content legitimately differs between the frozen bytes and the rendered
 * DOM — that divergence is the thing S12-1 exists to fix, so it is excluded from the PARITY
 * check rather than being allowed to read as a live-lane defect.
 *
 * DELIBERATELY ONE ENTRY. The exit gate says "the non-visibility classes", and the spec's
 * class list (§3.2) names `visibility_divergent` and `virtualized_list` separately. Adding
 * the second here would be widening an exclusion the spec did not grant, which weakens the
 * gate in exactly the direction that never gets noticed. If a populated `virtualized_list`
 * fixture turns out to diverge legitimately, that is a real finding for S12-1 to rule on —
 * not something this file should pre-absolve.
 */
export const VISIBILITY_CLASSES = new Set(['visibility_divergent']);

export interface ParityVerdict {
  ok: boolean;
  /** Assertions actually compared (i.e. after the visibility exclusions). */
  compared: number;
  /** Assertions excluded because they are visibility-class, and so legitimately divergent. */
  excluded: number;
  /** `key: frozen=X live=Y` for every assertion whose verdict differs across lanes. */
  mismatches: string[];
}

/**
 * S12-0's exit gate: the live lane must reproduce the frozen lane's score on the same
 * fixtures WITHIN 0.00 for the non-visibility classes.
 *
 * "Within 0.00" is exact equality, so this compares PER-ASSERTION verdicts rather than the
 * aggregate score. Two lanes can reach an identical aggregate while disagreeing on two
 * assertions in opposite directions; an aggregate comparison would call that parity and it is
 * not parity, it is two bugs cancelling.
 */
export function compareLanes(
  manifest: ScrapeManifest,
  frozen: ScrapeReport,
  live: ScrapeReport,
): ParityVerdict {
  const excludedKinds = new Set(['visible_only']);
  const kindOf = new Map<string, string>();
  const classOf = new Map<string, string>();
  for (const f of manifest.fixtures) {
    classOf.set(f.id, f.pageClass);
    f.assertions.forEach((a, i) => kindOf.set(`${f.id}#${i}`, a.kind));
  }

  const verdicts = (r: ScrapeReport): Map<string, boolean> => {
    const m = new Map<string, boolean>();
    for (const f of r.fixtures) f.assertions.forEach((a, i) => m.set(assertionKey(f.id, i, a.describe), a.passed));
    return m;
  };
  const frozenV = verdicts(frozen);
  const liveV = verdicts(live);

  const mismatches: string[] = [];
  let compared = 0;
  let excluded = 0;

  for (const f of frozen.fixtures) {
    f.assertions.forEach((a, i) => {
      const key = assertionKey(f.id, i, a.describe);
      const isVisibilityClass = VISIBILITY_CLASSES.has(classOf.get(f.id) ?? '');
      const isVisibilityKind = excludedKinds.has(kindOf.get(`${f.id}#${i}`) ?? '');
      if (isVisibilityClass || isVisibilityKind) {
        excluded += 1;
        return;
      }
      compared += 1;
      const fv = frozenV.get(key);
      const lv = liveV.get(key);
      if (lv === undefined) {
        mismatches.push(`${key}: frozen=${fv} live=ABSENT`);
        return;
      }
      if (fv !== lv) mismatches.push(`${key}: frozen=${fv} live=${lv}`);
    });
  }

  return { ok: mismatches.length === 0, compared, excluded, mismatches };
}

export function renderParity(v: ParityVerdict): string {
  const lines: string[] = ['', '## Live-lane parity (S12-0 exit gate)', ''];
  lines.push(`Compared ${v.compared} assertion(s); excluded ${v.excluded} visibility-class assertion(s).`);
  lines.push(v.ok ? '✅ live lane reproduces the frozen lane exactly (within 0.00)' : `❌ ${v.mismatches.length} lane mismatch(es)`);
  for (const m of v.mismatches) lines.push(`- ${m}`);
  return `${lines.join('\n')}\n`;
}
