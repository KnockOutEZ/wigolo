import { describe, it, expect, afterEach } from 'vitest';
import { guardServeTarget } from '../../../src/daemon/rest/target-guard.js';
import { SSRF_CODES } from '../../../src/watch/ssrf.js';

const orig = { ...process.env };
afterEach(() => {
  process.env = { ...orig };
  delete process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS;
});

describe('guardServeTarget', () => {
  it('loopback bind → loopback target allowed (delegates to fetch guard)', () => {
    const r = guardServeTarget('http://127.0.0.1:8080/', { bindIsLoopback: true });
    expect(r.ok).toBe(true);
  });

  it('non-loopback bind → loopback literal target refused', () => {
    const r = guardServeTarget('http://127.0.0.1:8080/', { bindIsLoopback: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(SSRF_CODES.PRIVATE_TARGET);
      expect(r.hint).toContain('WIGOLO_SERVE_ALLOW_LOCAL_TARGETS');
    }
  });

  it('non-loopback bind → localhost literal target refused', () => {
    const r = guardServeTarget('http://localhost:3000/', { bindIsLoopback: false });
    expect(r.ok).toBe(false);
  });

  it('non-loopback bind + WIGOLO_SERVE_ALLOW_LOCAL_TARGETS=1 → loopback target allowed', () => {
    process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS = '1';
    const r = guardServeTarget('http://127.0.0.1:8080/', { bindIsLoopback: false });
    expect(r.ok).toBe(true);
  });

  it('non-loopback bind → public target still passes', () => {
    const r = guardServeTarget('https://example.com/', { bindIsLoopback: false });
    expect(r.ok).toBe(true);
  });

  it('metadata target blocked even under loopback bind (fetch guard)', () => {
    const r = guardServeTarget('http://169.254.169.254/', { bindIsLoopback: true });
    expect(r.ok).toBe(false);
  });

  it('invalid URL → refused', () => {
    const r = guardServeTarget('not a url', { bindIsLoopback: true });
    expect(r.ok).toBe(false);
  });
});
