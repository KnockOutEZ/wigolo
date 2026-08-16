// arxiv / generic PDF fetch returned an empty body because the
// extractor's PDF branch called the v1 pdf-parse default-export API that no
// longer exists on pdf-parse@2.x. Wire the v2 PDFParse class form and verify
// at the tool boundary that handleFetch returns the actual extracted PDF
// text — not an empty envelope.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleFetch } from '../../src/tools/fetch.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';
import { SmartRouter } from '../../src/fetch/router.js';
import type {
  HttpClient,
  BrowserPoolInterface,
  SmartRouter as SmartRouterType,
  SystemBrowserFetch,
} from '../../src/fetch/router.js';
import type { RawFetchResult } from '../../src/types.js';

/**
 * The no-installed-browser half of this file's precondition, stated rather than inherited — the
 * same correction PR #326 applied to `tests/unit/fetch/router-browser-acquire.test.ts`.
 *
 * `https://react.dev/papers/hooks.pdf` RESOLVES. The row below is safe today only because the
 * injected `httpClient` returns PDF bytes, so the byte tier terminates before `browserFetch` is
 * ever reached. That is a property of an unrelated stub, not a stated precondition: return an SPA
 * shell from it instead — a plausible future edit — and the router escalates, the bundled engine
 * comes up unavailable on a no-display host, and the companion rung drives a REAL installed
 * browser at react.dev from an integration suite.
 *
 * `tests/net-fence.ts` cannot see that: the browser is a child process and resolves in its own
 * address space. Declining here is the only thing that closes it, and it weakens nothing — every
 * assertion below is unchanged, including `browserCalls` staying empty, which is what this row
 * actually guards.
 */
const noInstalledBrowser: SystemBrowserFetch = async () => null;

// Hand-rolled minimal "Hello, world!" PDF — same shape used in the unit
// pdf.test.ts so the integration assertion can verify text round-trip.
const HELLO_PDF_BASE64 = [
  'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUj4+CmVuZG9iagoy',
  'IDAgb2JqCjw8L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDE+PgplbmRvYmoKMyAw',
  'IG9iago8PC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL1Jlc291cmNlcyA8PC9Gb250IDw8L0Yx',
  'IDQgMCBSPj4+PiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNSAwIFI+PgplbmRv',
  'YmoKNCAwIG9iago8PC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZl',
  'dGljYT4+CmVuZG9iago1IDAgb2JqCjw8L0xlbmd0aCA0ND4+CnN0cmVhbQpCVAovRjEgMTggVGYK',
  'NTAgMTAwIFRkCihIZWxsbywgd29ybGQhKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2',
  'CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAw',
  'IG4gCjAwMDAwMDAxMDkgMDAwMDAgbiAKMDAwMDAwMDIxMyAwMDAwMCBuIAowMDAwMDAwMjg2IDAw',
  'MDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2IC9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjM3OQolJUVP',
  'Rg==',
].join('');

function helloPdfBuffer(): Buffer {
  return Buffer.from(HELLO_PDF_BASE64, 'base64');
}

function mockPdfRouter(pdfUrl: string): SmartRouterType {
  // Router stub that returns a raw PDF response for the arxiv-like URL.
  const router = {
    fetch: async (url: string): Promise<RawFetchResult> => {
      if (url !== pdfUrl) {
        return {
          url,
          finalUrl: url,
          html: '',
          contentType: 'text/plain',
          statusCode: 404,
          method: 'http' as const,
          headers: {},
        };
      }
      return {
        url,
        finalUrl: url,
        html: '',
        contentType: 'application/pdf',
        statusCode: 200,
        method: 'http' as const,
        headers: { 'content-type': 'application/pdf' },
        rawBuffer: helloPdfBuffer(),
      };
    },
    getDomainStats: () => undefined,
  } as unknown as SmartRouterType;
  return router;
}

describe('handleFetch — PDF (C6 boundary)', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns extracted PDF text on an arxiv-style PDF URL', async () => {
    const url = 'https://arxiv.org/pdf/2301.00001v1';
    const router = mockPdfRouter(url);
    const out = await handleFetch({ url }, router);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const data = out.data;
    // The bug: data.markdown was '' on every PDF URL. The fix must surface
    // the actual text content.
    expect(data.markdown.length).toBeGreaterThan(0);
    expect(data.markdown.toLowerCase()).toContain('hello');
    expect(data.http_status).toBe(200);
  });

  it('a .pdf on a preferPlaywright host is buffered by the byte tier, never handed to the browser', async () => {
    // Real SmartRouter routing (not a fully stubbed fetch). react.dev is a
    // known-SPA domain → starts preferPlaywright, so without the extension
    // pre-sniff a .pdf would route to Playwright, which throws on a download.
    // The pre-sniff must force HTTP so the PDF round-trips its extracted text.
    const url = 'https://react.dev/papers/hooks.pdf';
    const browserCalls: string[] = [];

    const httpClient: HttpClient = {
      fetch: async (u) => ({
        url: u,
        finalUrl: u,
        html: '',
        contentType: 'application/pdf',
        statusCode: 200,
        headers: { 'content-type': 'application/pdf' },
        rawBuffer: helloPdfBuffer(),
      }),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: async (u) => {
        browserCalls.push(u);
        throw new Error('Download is starting');
      },
    };
    const router = new SmartRouter({ httpClient, browserPool, systemBrowserFetch: noInstalledBrowser });

    const out = await handleFetch({ url }, router);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.markdown.length).toBeGreaterThan(0);
    expect(out.data.markdown.toLowerCase()).toContain('hello');
    expect(browserCalls).toEqual([]); // browser tier never touched
  });
});
