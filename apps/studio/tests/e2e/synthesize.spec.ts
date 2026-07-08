import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ElectronApplication } from 'playwright';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchStudio } from './launch';
import { readHandle, DaemonProxy } from 'wigolo/studio';

// GATED (RUN_STUDIO_E2E) — the real Electron app. Proves P6 F3 cross-tab synthesis END-TO-END: agent
// captures clips across the session → the renderer's "Synthesize session" (window.studio.synthesize) →
// the broker shapes the LOCAL corpus into a research brief (brief-shaping ONLY, no network) → persisted as
// a qa artifact (findable via find_similar). Zero captures → an honest empty, never a fabricated brief.
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');

interface BriefResult { empty?: true; brief?: { key_findings: string[] }; provenance?: Array<{ artifactId: number }> }

describe.skipIf(!RUN)('studio synthesis (e2e, real gateway + real DB broker)', () => {
  let app: ElectronApplication;
  let dataDir: string;
  let endpoint: string;
  let token: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-studio-p6f3-e2e-'));
    app = await launchStudio({
      args: [APP_MAIN],
      env: { ...process.env, WIGOLO_DATA_DIR: dataDir, WIGOLO_STUDIO_BROKER_NODE: process.execPath },
    });
    await app.firstWindow();
    const started = Date.now();
    let handle = readHandle(dataDir);
    while (!handle && Date.now() - started < 30_000) {
      await new Promise((r) => setTimeout(r, 250));
      handle = readHandle(dataDir);
    }
    if (!handle) throw new Error('gateway handle never published');
    endpoint = handle.endpoint;
    token = handle.token;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('captures across the session synthesize into a cited brief (persisted as a qa artifact)', async () => {
    const proxy = new DaemonProxy(endpoint, token);
    await proxy.callTool('studio_open', {});
    await proxy.callTool('studio_observe', {}); // stamps the epoch so capture TOCTOU passes

    await proxy.callTool('studio_capture', { type: 'clip', content: 'Wigolo is a local-first web intelligence MCP: search, fetch, crawl, extract — no API keys required for core work.', url: 'https://ex.com/one' });
    await proxy.callTool('studio_capture', { type: 'clip', content: 'It ranks results with an ML reranker and caches everything locally in SQLite for reuse across sessions.', url: 'https://ex.com/two' });

    const win = await app.firstWindow();
    const result = await win.evaluate(() =>
      (window as unknown as { studio: { synthesize(): Promise<BriefResult> } }).studio.synthesize());
    expect('brief' in result).toBe(true);
    expect(result.provenance?.length ?? 0).toBeGreaterThanOrEqual(2); // both captures fed the brief

    // the synthesis persisted a qa artifact + is findable via the local corpus (save-as-research)
    const caps = await win.evaluate(() =>
      (window as unknown as { studio: { listCaptures(): Promise<Array<{ type: string }>> } }).studio.listCaptures());
    expect(caps.some((c) => c.type === 'qa')).toBe(true);
  }, 60_000);

  it('a fresh session with no captures synthesizes to an honest empty (no fabricated brief)', async () => {
    const proxy = new DaemonProxy(endpoint, token);
    await proxy.callTool('studio_open', {}); // a NEW active session — zero captures

    const win = await app.firstWindow();
    const result = await win.evaluate(() =>
      (window as unknown as { studio: { synthesize(): Promise<BriefResult> } }).studio.synthesize());
    expect(result).toEqual({ empty: true });
  }, 40_000);
});
