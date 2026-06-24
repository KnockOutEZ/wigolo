import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../../src/cache/migrations/runner.js';
import type { IndexJobInput } from '../../../../src/embedding/background-queue.js';
import { createCaptureHandler } from '../../../../src/studio/capture/handler.js';
import type { ArtifactDelta } from '../../../../src/studio/capture/artifacts.js';

/**
 * Phase 7e S1 — the studio_capture handler forwards the onArtifact hook (integration at the tool boundary).
 * A clip/qa capture through the handler reaches the host's live {t:'artifact'} sink with the light projection;
 * a dedup re-capture (idempotent success) does NOT re-fire. Structural pin: drop the forward in the handler
 * (captureDeps omits onArtifact) ⇒ the delta never lands ⇒ RED.
 */
describe('studio/capture/handler — 7e S1 onArtifact forward (RED)', () => {
  let dir: string;
  let db: Database.Database;
  const HOST_SESSION = 'host-sess-7e';

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-studio-7e-h-'));
    db = new Database(join(dir, 'cache.db'));
    db.pragma('foreign_keys = ON');
    applyMigrations(db, { vecLoaded: false });
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function mkHandler(deltas: ArtifactDelta[]) {
    const jobs: IndexJobInput[] = [];
    return createCaptureHandler({
      sessionId: HOST_SESSION,
      db,
      enqueue: (j: IndexJobInput) => { jobs.push(j); },
      credentialContext: async () => ({}),
      currentNavEpoch: () => 0,
      lastObserveEpoch: () => 0,
      onArtifact: (d: ArtifactDelta) => { deltas.push(d); },
    });
  }

  it('a clip capture forwards onArtifact with the session-bound row\'s light projection', async () => {
    const deltas: ArtifactDelta[] = [];
    const handler = mkHandler(deltas);
    const out = await handler({ type: 'clip', url: 'https://x.example/p', content: 'clip body' });
    expect('artifact_id' in out).toBe(true);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].type).toBe('clip');
    expect(deltas[0].url).toBe('https://x.example/p');
    expect(deltas[0].trusted).toBe(false);
    expect((deltas[0] as unknown as Record<string, unknown>).markdown).toBeUndefined();
  });

  it('a dedup re-capture (idempotent success) does NOT re-fire the hook', async () => {
    const deltas: ArtifactDelta[] = [];
    const handler = mkHandler(deltas);
    await handler({ type: 'clip', url: 'https://x.example/p', content: 'same body' });
    const second = await handler({ type: 'clip', url: 'https://x.example/p', content: 'same body' });
    expect('artifact_id' in second && (second as { inserted: boolean }).inserted).toBe(false);
    expect(deltas).toHaveLength(1);
  });
});
