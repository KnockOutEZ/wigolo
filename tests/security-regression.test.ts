import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyHost, guardNavigation } from '../src/security/ssrf.js';
import { setMyInstanceId } from '../src/companion/handle.js';

/**
 * SECURITY-REGRESSION SUITE (CI-gating; run via `npm run test:security` and the full
 * `npm test`). A curated, INDEPENDENT re-assertion of the security controls core owns,
 * calling the production functions directly with adversarial inputs. It goes RED if a
 * control is reverted EVEN IF that control's own unit test is deleted — the exact
 * failure mode that silently reopened the vision region clamp. Do not weaken these;
 * a revert of a control must not be able to merge green.
 *
 * The four page-perception arms this suite opened with — the vision region clamp, the studio_*
 * proxy trust tag, the observe element weld and the capture trust clamp — left with the domain
 * layer they re-asserted. Re-asserting a control from outside the repo that implements it is not
 * an independent check, it is a stale copy; the companion repo carries them beside their code.
 */
describe('SECURITY-REGRESSION: core controls', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wigolo-secreg-')); setMyInstanceId(null); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); setMyInstanceId(null); });

  it('SSRF: cloud-metadata + 6to4/NAT64 embeddings + RFC1918 never classify public', () => {
    expect(classifyHost('169.254.169.254')).toBe('link_local');
    expect(classifyHost('[2002:a9fe:a9fe::]')).toBe('link_local'); // 6to4 metadata embedding
    expect(classifyHost('[64:ff9b::a9fe:a9fe]')).toBe('link_local'); // NAT64 metadata embedding
    expect(classifyHost('[2002:7f00::]')).toBe('loopback'); // 6to4 trailing-zero (127.0.0.0)
    expect(classifyHost('10.0.0.1')).toBe('private');
  });

  it('nav: the agent is blocked from localhost / RFC1918 / metadata by default; metadata even with a private grant', () => {
    expect(guardNavigation('http://169.254.169.254/', { source: 'agent' }).ok).toBe(false);
    expect(guardNavigation('http://localhost/', { source: 'agent' }).ok).toBe(false);
    expect(guardNavigation('http://10.0.0.1/', { source: 'agent' }).ok).toBe(false);
    expect(guardNavigation('http://169.254.169.254/', { source: 'agent', allowPrivate: true }).ok).toBe(false);
  });

});
