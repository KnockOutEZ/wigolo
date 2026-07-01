// arxiv PDF fetch error'd out and killed paper retrieval. Root cause:
// pdf-parse@2.x exposes a `PDFParse` class with `.getText({})`, NOT a default
// function. The legacy code did `(await import('pdf-parse')).default` which
// resolves to `undefined`, the call throws "pdfParse is not a function", the
// catch logs a warning, and the PDF body comes back empty.
//
// This file tests the V1Extractor PDF branch directly with a real arxiv PDF
// buffer so the wiring stays correct on future pdf-parse upgrades.

import { describe, it, expect } from 'vitest';
import { V1Extractor } from '../../../../src/extraction/v1/extract-provider.js';

// Minimal in-memory PDF generated via pdfkit-shape primitives. Smallest
// possible "Hello World" PDF that pdf.js can parse. Hand-rolled so we don't
// add a fixture binary to the repo. Verified locally that pdf-parse extracts
// "Hello, world!" from this byte stream.
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

describe('V1Extractor — PDF (C6)', () => {
  // Timeout bumped well above the 20s global default: pdf-parse@2 lazily
  // boots the underlying pdf.js engine (WASM + font/CMap data + first-call
  // JIT) on the first getText() of the process. On a cold Windows CI runner
  // that one-time init is an order of magnitude slower than on macOS/Linux
  // (~0.5s locally) and intermittently overran the 20s default, while passing
  // everywhere else — i.e. genuine first-run slowness, not a hang (the promise
  // always resolves). The higher ceiling absorbs the cold-start without
  // masking a real regression: a true empty-body regression still fails fast
  // on the content assertions below.
  it('extracts text from a PDF buffer (regression for pdf-parse v2 API)', async () => {
    const extractor = new V1Extractor();
    const result = await extractor.extract('', 'https://arxiv.org/pdf/2301.00001v1', {
      contentType: 'application/pdf',
      pdfBuffer: helloPdfBuffer(),
    });

    expect(result).toBeTruthy();
    expect(result.markdown).toBeTypeOf('string');
    // The bug surfaced as empty markdown because pdfParse() threw. The fix
    // must surface the actual text content from the PDF buffer.
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.markdown.toLowerCase()).toContain('hello');
  }, 60000);

  it('returns a useful envelope on a non-PDF content-type with no buffer (defence-in-depth)', async () => {
    const extractor = new V1Extractor();
    // Non-PDF content-type goes through the routed extractor; we just want
    // to confirm the PDF branch only triggers on application/pdf.
    const result = await extractor.extract(
      '<html><body><h1>Hi</h1><p>Some article content that should run through readability.</p></body></html>',
      'https://example.com/article',
      { contentType: 'text/html' },
    );
    expect(result).toBeTruthy();
    expect(result.markdown).toBeTypeOf('string');
  });
});
