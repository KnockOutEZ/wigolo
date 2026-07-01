import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  amazonExtractor,
  extractAmazonProduct,
} from '../../../../src/extraction/site-extractors/amazon.js';

const fixturesDir = join(import.meta.dirname, '../../../fixtures/amazon');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

const ELECTRONICS_HTML = loadFixture('electronics.html');
const BOOK_HTML = loadFixture('book.html');
const GROCERY_HTML = loadFixture('grocery.html');
const OOS_HTML = loadFixture('out-of-stock.html');
const UK_HTML = loadFixture('uk-pound.html');
const DE_HTML = loadFixture('de-euro.html');

describe('amazonExtractor.canHandle', () => {
  it('matches amazon.com product URLs because Amazon products live under /dp/<asin>/', () => {
    expect(amazonExtractor.canHandle('https://www.amazon.com/dp/B08N5WRWNW/')).toBe(true);
  });

  it('matches amazon.com /gp/product/ URLs because that is the legacy product path still in use', () => {
    expect(amazonExtractor.canHandle('https://www.amazon.com/gp/product/B08N5WRWNW')).toBe(true);
  });

  it('matches amazon.co.uk because UK is the highest non-US Amazon market by volume', () => {
    expect(amazonExtractor.canHandle('https://www.amazon.co.uk/dp/B09KETTLE1/')).toBe(true);
  });

  it('matches amazon.de because the EU template is identical to US and selectors must work there', () => {
    expect(amazonExtractor.canHandle('https://www.amazon.de/dp/B09KETTLE1/')).toBe(true);
  });

  it('matches the amzn.to short-link domain because shared product links use it', () => {
    expect(amazonExtractor.canHandle('https://amzn.to/3xYz9aB')).toBe(true);
  });

  it('rejects non-amazon hosts so the fallback extractor chain stays in charge of them', () => {
    expect(amazonExtractor.canHandle('https://www.example.com/dp/B08N5WRWNW/')).toBe(false);
  });

  it('rejects amazon-shaped paths on unrelated domains so a path collision cannot hijack extraction', () => {
    expect(amazonExtractor.canHandle('https://example.com/amazon.com/dp/B08N5WRWNW')).toBe(false);
  });

  it('rejects spoofed hosts like amazon.com.attacker.com because hostname suffix matching must be boundary-anchored', () => {
    expect(amazonExtractor.canHandle('https://amazon.com.attacker.com/dp/B08N5WRWNW')).toBe(false);
  });

  it('rejects amazon.com signin and account paths because they are not product pages', () => {
    expect(amazonExtractor.canHandle('https://www.amazon.com/ap/signin')).toBe(false);
  });

  it('rejects malformed URLs without throwing so the registry stays loop-safe', () => {
    expect(amazonExtractor.canHandle('not-a-url')).toBe(false);
  });
});

describe('amazonExtractor — electronics fixture', () => {
  const url = 'https://www.amazon.com/dp/B08N5WRWNW/';

  it('returns a non-null ExtractionResult so the routed pipeline accepts the extractor', () => {
    expect(amazonExtractor.extract(ELECTRONICS_HTML, url)).not.toBeNull();
  });

  it('tags the result as site-specific so cache + telemetry can attribute the extractor', () => {
    const r = amazonExtractor.extract(ELECTRONICS_HTML, url)!;
    expect(r.extractor).toBe('site-specific');
  });

  it('extracts the productTitle text because that is the canonical product name field', () => {
    const r = amazonExtractor.extract(ELECTRONICS_HTML, url)!;
    expect(r.title).toContain('Acme Wireless Noise-Cancelling Headphones');
  });

  it('renders the structured fields into markdown so downstream LLM tools see the data', () => {
    const r = amazonExtractor.extract(ELECTRONICS_HTML, url)!;
    expect(r.markdown).toContain('Acme');
    expect(r.markdown).toContain('249.99');
    expect(r.markdown).toContain('4.5');
  });

  it('surfaces feature bullets in markdown so summarisers can quote them', () => {
    const r = amazonExtractor.extract(ELECTRONICS_HTML, url)!;
    expect(r.markdown).toContain('noise cancellation');
  });

  it('returns at least one image URL because every product page must have a hero image', () => {
    const r = amazonExtractor.extract(ELECTRONICS_HTML, url)!;
    expect(r.images.length).toBeGreaterThan(0);
  });
});

describe('extractAmazonProduct — electronics fixture', () => {
  const url = 'https://www.amazon.com/dp/B08N5WRWNW/';

  it('derives the ASIN from the URL path because the URL is the most reliable source', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.asin).toBe('B08N5WRWNW');
  });

  it('parses the price as a float so callers can sort/compare numerically', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.price).toBeCloseTo(249.99, 2);
  });

  it('maps the $ symbol to ISO 4217 USD so callers do not have to do currency mapping', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.currency).toBe('USD');
  });

  it('parses the rating from the a-icon-alt text because that is the screen-reader source of truth', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.rating).toBeCloseTo(4.5, 1);
  });

  it('parses review_count even with comma thousands separators because Amazon always formats with commas', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.review_count).toBe(12438);
  });

  it('returns features as a non-empty string list so downstream prompts can iterate', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.features.length).toBeGreaterThanOrEqual(5);
    expect(p.features[0]).toMatch(/noise cancellation/i);
  });

  it('extracts brand from the byline because product overview duplicates byline-derived data', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.brand.toLowerCase()).toContain('acme');
  });

  it('drops the data-uri placeholder image so consumers never embed inline base64 garbage', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.images.every((u) => u.startsWith('http'))).toBe(true);
    expect(p.images.some((u) => u.startsWith('data:'))).toBe(false);
  });

  it('drops tracking-pixel image URLs because they are not real product images and would mislead callers', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.images.some((u) => u.includes('/tracking/'))).toBe(false);
  });

  it('collects specifications from the product overview table because they describe the product variant', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.specifications['Color']).toBe('Black');
    expect(p.specifications['Model Name']).toBe('Acme NC-700');
  });

  it('reports in_stock for the success-coloured availability text so callers can branch on it', () => {
    const p = extractAmazonProduct(ELECTRONICS_HTML, url)!;
    expect(p.availability).toBe('in_stock');
  });
});

describe('extractAmazonProduct — book fixture', () => {
  const url = 'https://www.amazon.com/dp/0135957052/';

  it('extracts a title even when there are no feature bullets because books rarely have them', () => {
    const p = extractAmazonProduct(BOOK_HTML, url)!;
    expect(p.title).toContain('Pragmatic Programmer');
  });

  it('returns an empty features array gracefully so callers can rely on the shape being defined', () => {
    const p = extractAmazonProduct(BOOK_HTML, url)!;
    expect(Array.isArray(p.features)).toBe(true);
    expect(p.features).toEqual([]);
  });

  it('still parses price for books because the Kindle/hardcover offer block reuses the same selector', () => {
    const p = extractAmazonProduct(BOOK_HTML, url)!;
    expect(p.price).toBeCloseTo(39.99, 2);
  });

  it('uses the productDescription div when feature-bullets is absent because that is where book blurbs live', () => {
    const p = extractAmazonProduct(BOOK_HTML, url)!;
    expect(p.description.toLowerCase()).toContain('pragmatic programmer');
  });

  it('exposes book metadata in specifications because ISBN-13 is a load-bearing identifier for callers', () => {
    const p = extractAmazonProduct(BOOK_HTML, url)!;
    const isbn13 = p.specifications['ISBN-13'];
    expect(isbn13).toContain('978-0135957059');
  });
});

describe('extractAmazonProduct — grocery fixture', () => {
  const url = 'https://www.amazon.com/dp/B0042NS3I8/';

  it('parses the grocery title even though the layout omits productDescription', () => {
    const p = extractAmazonProduct(GROCERY_HTML, url)!;
    expect(p.title).toContain('Rolled Oats');
  });

  it('extracts the brand from "Brand: X" byline because grocery products use that phrasing', () => {
    const p = extractAmazonProduct(GROCERY_HTML, url)!;
    expect(p.brand).toContain("Bob's Red Mill");
  });

  it('collects grocery feature bullets because diet/origin claims often live there', () => {
    const p = extractAmazonProduct(GROCERY_HTML, url)!;
    expect(p.features.some((f) => f.toLowerCase().includes('organic'))).toBe(true);
  });
});

describe('extractAmazonProduct — out-of-stock fixture', () => {
  const url = 'https://www.amazon.com/dp/B07XYZ1234/';

  it('returns availability=out_of_stock when the price block is gone but OOS text is present', () => {
    const p = extractAmazonProduct(OOS_HTML, url)!;
    expect(p.availability).toBe('out_of_stock');
  });

  it('returns null price (not 0, not NaN) for OOS because zero would falsely sort as "cheapest"', () => {
    const p = extractAmazonProduct(OOS_HTML, url)!;
    expect(p.price).toBeNull();
  });

  it('leaves currency empty when there is no price because guessing currency is wrong', () => {
    const p = extractAmazonProduct(OOS_HTML, url)!;
    expect(p.currency).toBe('');
  });

  it('still extracts ASIN from URL on OOS pages so cache keys stay stable across stock changes', () => {
    const p = extractAmazonProduct(OOS_HTML, url)!;
    expect(p.asin).toBe('B07XYZ1234');
  });

  it('still extracts rating + review_count for OOS so historical data is preserved', () => {
    const p = extractAmazonProduct(OOS_HTML, url)!;
    expect(p.rating).toBeCloseTo(3.9, 1);
    expect(p.review_count).toBe(42);
  });
});

describe('extractAmazonProduct — UK locale fixture', () => {
  const url = 'https://www.amazon.co.uk/dp/B09KETTLE1/';

  it('maps the GBP symbol to ISO 4217 GBP so callers do not have to handle locale themselves', () => {
    const p = extractAmazonProduct(UK_HTML, url)!;
    expect(p.currency).toBe('GBP');
  });

  it('parses the numeric value of a GBP price correctly because the symbol must not contaminate the number', () => {
    const p = extractAmazonProduct(UK_HTML, url)!;
    expect(p.price).toBeCloseTo(49.99, 2);
  });

  it('derives ASIN from the co.uk URL because TLD must not break the URL-first ASIN heuristic', () => {
    const p = extractAmazonProduct(UK_HTML, url)!;
    expect(p.asin).toBe('B09KETTLE1');
  });
});

describe('extractAmazonProduct — error / edge cases', () => {
  it('returns null on empty HTML because the registry uses null to mean "I cannot handle this"', () => {
    expect(extractAmazonProduct('', 'https://www.amazon.com/dp/B08N5WRWNW/')).toBeNull();
  });

  it('returns null when productTitle is missing because we should not fabricate a title', () => {
    const html = '<html><body><div>nothing useful here</div></body></html>';
    expect(extractAmazonProduct(html, 'https://www.amazon.com/dp/B08N5WRWNW/')).toBeNull();
  });

  it('falls back to data-asin attribute when the URL has no /dp/<asin>/ segment so search-result snapshots still work', () => {
    const html = `<html><body>
      <div id="dp" data-asin="B0FALLBACK">
        <span id="productTitle">Fallback ASIN Product</span>
      </div>
    </body></html>`;
    const p = extractAmazonProduct(html, 'https://www.amazon.com/some/other/path');
    expect(p?.asin).toBe('B0FALLBACK');
  });
});

describe('extractAmazonProduct — DE locale (EUR) fixture', () => {
  const url = 'https://www.amazon.de/dp/B08N5WRWNW/';

  it('maps the € symbol to ISO 4217 EUR so amazon.de prices carry the right currency code', () => {
    const p = extractAmazonProduct(DE_HTML, url)!;
    expect(p.currency).toBe('EUR');
  });

  it('parses the German "299,00" decimal correctly because comma-as-decimal is the EU convention', () => {
    const p = extractAmazonProduct(DE_HTML, url)!;
    expect(p.price).toBeCloseTo(299.0, 2);
  });

  it('extracts ASIN from an amazon.de URL because every locale TLD must route through the same ASIN heuristic', () => {
    const p = extractAmazonProduct(DE_HTML, url)!;
    expect(p.asin).toBe('B08N5WRWNW');
  });
});

describe('extractAmazonProduct — image filtering edge cases', () => {
  const url = 'https://www.amazon.com/dp/B08N5WRWNW/';

  it('drops /x-locale/ helper assets from images because they are locale shims, not product photos', () => {
    const html = `<html><body>
      <span id="productTitle">X-Locale Filter Test</span>
      <div id="imageBlock">
        <img id="landingImage" src="https://m.media-amazon.com/images/I/hero.jpg" alt="Hero">
        <img src="https://example.com/x-locale/strings.png">
        <img src="https://m.media-amazon.com/images/I/alt-1.jpg">
      </div>
    </body></html>`;
    const p = extractAmazonProduct(html, url)!;
    expect(p.images.some((u) => u.includes('/x-locale/'))).toBe(false);
    expect(p.images.length).toBeGreaterThan(0);
  });
});

describe('extractAmazonProduct — features soft cap', () => {
  const url = 'https://www.amazon.com/dp/B08N5WRWNW/';

  it('caps features at 100 entries so an adversarial 10k-<li> page cannot blow up memory or prompt budgets', () => {
    const bullets = Array.from({ length: 500 }, (_, i) => `<li><span class="a-list-item">Feature number ${i}</span></li>`).join('');
    const html = `<html><body>
      <span id="productTitle">Adversarial Bullet Count</span>
      <div id="feature-bullets"><ul>${bullets}</ul></div>
    </body></html>`;
    const p = extractAmazonProduct(html, url)!;
    expect(p.features.length).toBeLessThanOrEqual(100);
    expect(p.features.length).toBeGreaterThan(0);
  });
});

describe('extractAmazonProduct — prototype pollution guards on specifications', () => {
  const url = 'https://www.amazon.com/dp/B08N5WRWNW/';

  it('drops __proto__ rows from the overview specifications table so a hostile page cannot smuggle reserved keys', () => {
    const html = `<html><body>
      <span id="productTitle">Proto Pollution Overview Test</span>
      <div id="productOverview_feature_div">
        <table>
          <tr><td>__proto__</td><td>polluted-overview</td></tr>
          <tr><td>constructor</td><td>polluted-ctor</td></tr>
          <tr><td>prototype</td><td>polluted-proto</td></tr>
          <tr><td>Color</td><td>Black</td></tr>
        </table>
      </div>
    </body></html>`;
    const p = extractAmazonProduct(html, url)!;
    expect(Object.prototype.hasOwnProperty.call(p.specifications, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(p.specifications, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(p.specifications, 'prototype')).toBe(false);
    expect(p.specifications['Color']).toBe('Black');
  });

  it('drops "constructor :" detail-bullet entries because attacker-controlled labels must not land in reserved slots', () => {
    const html = `<html><body>
      <span id="productTitle">Proto Pollution Detail Bullet Test</span>
      <div id="detailBullets_feature_div">
        <ul>
          <li><span class="a-text-bold">__proto__ :</span> <span>polluted-bullet</span></li>
          <li><span class="a-text-bold">constructor :</span> <span>polluted-ctor</span></li>
          <li><span class="a-text-bold">prototype :</span> <span>polluted-proto</span></li>
          <li><span class="a-text-bold">ASIN :</span> <span>B08N5WRWNW</span></li>
        </ul>
      </div>
    </body></html>`;
    const p = extractAmazonProduct(html, url)!;
    expect(Object.prototype.hasOwnProperty.call(p.specifications, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(p.specifications, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(p.specifications, 'prototype')).toBe(false);
    expect(p.specifications['ASIN']).toBe('B08N5WRWNW');
  });

  it('leaves Object.prototype untouched after parsing reserved-key rows so global object integrity is preserved', () => {
    const html = `<html><body>
      <span id="productTitle">Global Pollution Probe</span>
      <div id="productOverview_feature_div">
        <table>
          <tr><td>__proto__</td><td>polluted</td></tr>
        </table>
      </div>
      <div id="detailBullets_feature_div">
        <ul>
          <li><span class="a-text-bold">constructor :</span> <span>polluted</span></li>
        </ul>
      </div>
    </body></html>`;
    extractAmazonProduct(html, url);
    // If Object.prototype were polluted, every plain object would expose .polluted.
    const probe: Record<string, unknown> = {};
    expect(probe['polluted']).toBeUndefined();
  });
});

// Amazon "Page Not Found" / anti-bot pages were previously
// silently treated as Amazon product responses — no site_data emitted, no
// signal to caller. Detect the block / not-found pages and refuse to
// produce fake site_data.
describe('amazonExtractor — anti-bot / not-found detection', () => {
  const BLOCKED_HTML = loadFixture('blocked.html');
  const url = 'https://www.amazon.com/dp/B08N5WRWNW/';

  it('detectAntiBotBlock returns "blocked" for an Amazon Page Not Found challenge body', async () => {
    const { detectAntiBotBlock } = await import(
      '../../../../src/extraction/site-extractors/amazon.js'
    );
    expect(detectAntiBotBlock(BLOCKED_HTML)).toBe('blocked');
  });

  it('detectAntiBotBlock returns null for a real Amazon product page (no false positive)', async () => {
    const { detectAntiBotBlock } = await import(
      '../../../../src/extraction/site-extractors/amazon.js'
    );
    expect(detectAntiBotBlock(ELECTRONICS_HTML)).toBeNull();
  });

  it('extract returns null on a blocked / not-found body (must not pretend success)', () => {
    expect(amazonExtractor.extract(BLOCKED_HTML, url)).toBeNull();
  });
});
