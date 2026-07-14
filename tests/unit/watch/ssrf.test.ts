import { describe, it, expect } from 'vitest';
import { guardUrl, guardFetchUrl } from '../../../src/watch/ssrf.js';

/**
 * WHY this matters: the `watch` tool fetches `url` on an interval AND, when
 * `notification` is a webhook URL, POSTs the diff to that URL on every
 * change. Without an SSRF guard, a hostile job could probe the local
 * network (cloud metadata endpoints, internal services, loopback admin
 * panels) and exfiltrate data. The guard must run at registration time so
 * a bad URL never makes it into persistent state; otherwise a daemon
 * restart re-introduces the vulnerability.
 *
 * These tests pin the explicit reject list called out in the slice spec:
 *   - http://localhost / 127.0.0.1 / ::1 / 0.0.0.0
 *   - RFC 1918 private ranges (10/8, 172.16/12, 192.168/16)
 *   - link-local (169.254/16)
 *   - non-http(s) schemes
 */
describe('guardUrl SSRF', () => {
  describe('accepts public http(s) URLs', () => {
    it('accepts a vanilla https URL', () => {
      const r = guardUrl('https://example.com/path', 'url');
      expect(r.ok).toBe(true);
    });

    it('accepts a vanilla http URL', () => {
      const r = guardUrl('http://example.com/', 'url');
      expect(r.ok).toBe(true);
    });

    it('accepts a public IPv4 hostname', () => {
      const r = guardUrl('https://8.8.8.8/', 'url');
      expect(r.ok).toBe(true);
    });

    it('accepts a query string and fragment', () => {
      const r = guardUrl('https://example.com/page?q=1#frag', 'url');
      expect(r.ok).toBe(true);
    });
  });

  describe('rejects loopback hostnames', () => {
    it('rejects http://localhost', () => {
      const r = guardUrl('http://localhost', 'url');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/loopback|private/i);
    });

    it('rejects http://localhost:3000', () => {
      const r = guardUrl('http://localhost:3000/api', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects http://127.0.0.1', () => {
      const r = guardUrl('http://127.0.0.1/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects http://127.1.2.3 (still in 127/8)', () => {
      const r = guardUrl('http://127.1.2.3/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects http://[::1]/', () => {
      const r = guardUrl('http://[::1]/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects http://0.0.0.0/', () => {
      const r = guardUrl('http://0.0.0.0/', 'url');
      expect(r.ok).toBe(false);
    });
  });

  describe('rejects RFC 1918 private ranges', () => {
    it('rejects 10.x.x.x', () => {
      const r = guardUrl('http://10.0.0.5/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects 172.16.x.x', () => {
      const r = guardUrl('http://172.16.0.1/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects 172.31.x.x (top of 172.16/12)', () => {
      const r = guardUrl('http://172.31.255.255/', 'url');
      expect(r.ok).toBe(false);
    });

    it('accepts 172.15.x.x (just outside 172.16/12)', () => {
      const r = guardUrl('http://172.15.0.1/', 'url');
      expect(r.ok).toBe(true);
    });

    it('accepts 172.32.x.x (just outside 172.16/12)', () => {
      const r = guardUrl('http://172.32.0.1/', 'url');
      expect(r.ok).toBe(true);
    });

    it('rejects 192.168.x.x', () => {
      const r = guardUrl('http://192.168.1.1/', 'url');
      expect(r.ok).toBe(false);
    });
  });

  describe('rejects link-local 169.254/16', () => {
    it('rejects 169.254.169.254 (AWS metadata)', () => {
      const r = guardUrl('http://169.254.169.254/latest/meta-data/', 'url');
      expect(r.ok).toBe(false);
    });
  });

  describe('rejects non-http(s) schemes', () => {
    it('rejects file://', () => {
      const r = guardUrl('file:///etc/passwd', 'url');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/protocol/i);
    });

    it('rejects ftp://', () => {
      const r = guardUrl('ftp://example.com/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects data:', () => {
      const r = guardUrl('data:text/plain,hello', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects gopher://', () => {
      const r = guardUrl('gopher://example.com/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects javascript:', () => {
      const r = guardUrl('javascript:alert(1)', 'url');
      expect(r.ok).toBe(false);
    });
  });

  describe('rejects IPv6 private ranges', () => {
    it('rejects link-local fe80::', () => {
      const r = guardUrl('http://[fe80::1]/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects unique-local fc00::', () => {
      const r = guardUrl('http://[fc00::1]/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects fd00:: (also unique-local)', () => {
      const r = guardUrl('http://[fd12:3456:789a::1]/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects IPv4-mapped loopback ::ffff:127.0.0.1', () => {
      const r = guardUrl('http://[::ffff:127.0.0.1]/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects IPv4-compatible loopback ::127.0.0.1 (dotted)', () => {
      // The deprecated IPv4-compatible IPv6 form. WHATWG URL parsing
      // normalizes this to [::7f00:1] (no `ffff:` segment), which a guard
      // that only looks for the `ffff:` IPv4-mapped form will miss.
      // Some Linux kernels still route this to the embedded IPv4, so it's
      // a documented SSRF bypass class.
      const r = guardUrl('http://[::127.0.0.1]/', 'url');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/loopback|private/i);
    });

    it('rejects IPv4-compatible loopback hex form [::7f00:1]', () => {
      // Same address as ::127.0.0.1 after normalization — the guard must
      // catch the hex shape directly because that's what `new URL()` emits.
      const r = guardUrl('http://[::7f00:1]/', 'url');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/loopback|private/i);
    });

    it('rejects IPv4-compatible private 10.0.0.1 in IPv6 form', () => {
      // 10.0.0.1 -> 0a00:0001 -> [::a00:1]
      const r = guardUrl('http://[::a00:1]/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects IPv4-compatible link-local 169.254.169.254 in IPv6 form', () => {
      // 169.254.169.254 -> a9fe:a9fe -> [::a9fe:a9fe]
      const r = guardUrl('http://[::a9fe:a9fe]/', 'url');
      expect(r.ok).toBe(false);
    });

    it('accepts IPv4-compatible PUBLIC 8.8.8.8 in IPv6 form', () => {
      // 8.8.8.8 -> 0808:0808 -> [::808:808] — embedded address is public,
      // so the guard must NOT reject it. Pins that the decode is precise
      // and doesn't over-reject every `::a:b` shape.
      const r = guardUrl('http://[::808:808]/', 'url');
      expect(r.ok).toBe(true);
    });
  });

  describe('rejects malformed inputs', () => {
    it('rejects an empty string', () => {
      const r = guardUrl('', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects whitespace-only', () => {
      const r = guardUrl('   ', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects garbage that does not parse as a URL', () => {
      const r = guardUrl('not a url', 'url');
      expect(r.ok).toBe(false);
    });
  });

  describe('field label is reflected in the error', () => {
    it('uses the supplied label so the caller knows which field failed', () => {
      const r = guardUrl('http://localhost', 'notification');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('notification');
    });
  });
});

/**
 * guardFetchUrl is the loopback-permissive variant used by `fetch`/`crawl`
 * /`extract`/`agent`. Same threat model as guardUrl but loopback (127/8, ::1)
 * is exempt because the docs explicitly allow local dev servers.
 *
 * Link-local (169.254/16) is ALWAYS blocked — covers cloud metadata endpoints
 * (AWS / GCP / Azure use 169.254.169.254). There's no legitimate reason for
 * a generic fetch tool to hit a metadata endpoint.
 */
describe('guardFetchUrl SSRF', () => {
  describe('loopback is allowed by default', () => {
    it('accepts http://localhost:3000', () => {
      const r = guardFetchUrl('http://localhost:3000/', 'url');
      expect(r.ok).toBe(true);
    });

    it('accepts http://127.0.0.1:8080', () => {
      const r = guardFetchUrl('http://127.0.0.1:8080/health', 'url');
      expect(r.ok).toBe(true);
    });

    it('accepts http://127.5.4.3 (loopback, weird octet)', () => {
      const r = guardFetchUrl('http://127.5.4.3/', 'url');
      expect(r.ok).toBe(true);
    });

    it('blocks 0.0.0.0 (unspecified address)', () => {
      const r = guardFetchUrl('http://0.0.0.0:8080/', 'url');
      expect(r.ok).toBe(false);
    });
  });

  describe('link-local is ALWAYS blocked (even with allowPrivate)', () => {
    it('rejects 169.254.169.254 (cloud metadata) by default', () => {
      const r = guardFetchUrl('http://169.254.169.254/latest/meta-data/', 'url');
      expect(r.ok).toBe(false);
    });

    it('rejects 169.254.169.254 even when allowPrivate=true', () => {
      const r = guardFetchUrl('http://169.254.169.254/latest/meta-data/', 'url', {
        allowPrivate: true,
      });
      expect(r.ok).toBe(false);
    });

    it('rejects metadata.google.internal by name', () => {
      const r = guardFetchUrl('http://metadata.google.internal/computeMetadata/v1/', 'url');
      expect(r.ok).toBe(false);
    });
  });

  describe('private LAN ranges are blocked by default', () => {
    it('rejects 10.x.x.x', () => {
      expect(guardFetchUrl('http://10.0.0.1/admin', 'url').ok).toBe(false);
    });

    it('rejects 192.168.x.x', () => {
      expect(guardFetchUrl('http://192.168.1.1/admin', 'url').ok).toBe(false);
    });

    it('rejects 172.16-31.x.x', () => {
      expect(guardFetchUrl('http://172.20.5.10/', 'url').ok).toBe(false);
    });

    it('rejects CGN (100.64-127.x.x)', () => {
      expect(guardFetchUrl('http://100.70.1.1/', 'url').ok).toBe(false);
    });
  });

  describe('allowPrivate=true lifts LAN blocks', () => {
    it('accepts 192.168.x.x when allowPrivate=true', () => {
      const r = guardFetchUrl('http://192.168.1.1/admin', 'url', { allowPrivate: true });
      expect(r.ok).toBe(true);
    });

    it('accepts 10.x.x.x when allowPrivate=true', () => {
      const r = guardFetchUrl('http://10.0.0.1/', 'url', { allowPrivate: true });
      expect(r.ok).toBe(true);
    });
  });

  describe('public addresses always pass', () => {
    it('accepts a public IPv4', () => {
      expect(guardFetchUrl('https://1.1.1.1/', 'url').ok).toBe(true);
    });

    it('accepts a public hostname', () => {
      expect(guardFetchUrl('https://news.ycombinator.com/', 'url').ok).toBe(true);
    });
  });

  describe('forbidden schemes always rejected', () => {
    it('rejects file://', () => {
      expect(guardFetchUrl('file:///etc/passwd', 'url').ok).toBe(false);
    });

    it('rejects ftp://', () => {
      expect(guardFetchUrl('ftp://example.com/', 'url').ok).toBe(false);
    });

    it('rejects gopher://', () => {
      expect(guardFetchUrl('gopher://example.com/', 'url').ok).toBe(false);
    });
  });
});
