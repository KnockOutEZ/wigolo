import { describe, it, expect } from 'vitest';
import { redactUrl } from '../../../src/util/redact-url.js';

describe('redactUrl', () => {
  it('strips inline userinfo (user:pass@)', () => {
    const out = redactUrl('https://alice:s3cret@proxy.example.com:8080/path');
    expect(out).not.toContain('alice');
    expect(out).not.toContain('s3cret');
    expect(out).toContain('proxy.example.com:8080');
  });

  it('strips the query string (may carry a token)', () => {
    const out = redactUrl('https://reader.example.com/render?url=https://target.com&token=abc123');
    expect(out).not.toContain('token=abc123');
    expect(out).not.toContain('abc123');
    expect(out).toContain('reader.example.com');
  });

  it('preserves scheme, host, port and path', () => {
    expect(redactUrl('http://host.example:9000/a/b')).toBe('http://host.example:9000/a/b');
  });

  it('returns a stable placeholder for an unparseable value', () => {
    const out = redactUrl('not a url at all');
    expect(out).not.toContain('not a url');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('handles a bare userinfo with no password', () => {
    const out = redactUrl('https://tokenonly@sidecar.local/');
    expect(out).not.toContain('tokenonly');
    expect(out).toContain('sidecar.local');
  });
});
