import { describe, it, expect } from 'vitest';
import { extractJobPosting } from '../../../../../src/extraction/v1/schemas/JobPosting.js';

function htmlWithJsonLd(obj: unknown): string {
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`;
}

describe('extractJobPosting — JSON-LD path', () => {
  it('extracts a JobPosting with nested organization, location, and salary', async () => {
    const html = htmlWithJsonLd({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Senior Software Engineer',
      datePosted: '2025-09-12',
      validThrough: '2025-10-12',
      employmentType: 'FULL_TIME',
      description: 'Build and maintain backend services.',
      hiringOrganization: {
        '@type': 'Organization',
        name: 'Acme Corp',
      },
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          streetAddress: '123 Main',
          addressLocality: 'San Francisco',
          addressRegion: 'CA',
          addressCountry: 'US',
        },
      },
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: {
          '@type': 'QuantitativeValue',
          minValue: 120000,
          maxValue: 160000,
          unitText: 'YEAR',
        },
      },
    });
    const result = await extractJobPosting(html, 'https://example.com/jobs/1');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Senior Software Engineer');
    expect(result!.hiringOrganization).toBe('Acme Corp');
    expect(result!.jobLocation).toBe('123 Main, San Francisco, CA, US');
    expect(result!.datePosted).toBe('2025-09-12');
    expect(result!.validThrough).toBe('2025-10-12');
    expect(result!.employmentType).toBe('FULL_TIME');
    expect(result!.baseSalary).toBe('USD 120000-160000/YEAR');
    expect(result!.description).toBe('Build and maintain backend services.');
    expect(result!.url).toBe('https://example.com/jobs/1');
  });
});

describe('extractJobPosting — meta fallback', () => {
  it('uses job:* meta + h1 for title', async () => {
    const html = `<!doctype html><html><head>
      <meta property="job:date_posted" content="2025-09-12">
      <meta property="job:valid_through" content="2025-10-12">
      <meta property="job:location" content="Remote">
      <meta property="job:hiring_organization" content="Acme Corp">
      <meta property="og:description" content="Join our team">
    </head><body><h1>Senior Software Engineer</h1></body></html>`;
    const result = await extractJobPosting(html, 'https://example.com/jobs/1');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Senior Software Engineer');
    expect(result!.hiringOrganization).toBe('Acme Corp');
    expect(result!.jobLocation).toBe('Remote');
    expect(result!.datePosted).toBe('2025-09-12');
    expect(result!.validThrough).toBe('2025-10-12');
    expect(result!.description).toBe('Join our team');
  });

  it('falls back to og:title when no h1 present', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Backend Engineer">
    </head><body></body></html>`;
    const result = await extractJobPosting(html, 'https://example.com/jobs/2');
    expect(result!.title).toBe('Backend Engineer');
  });

  it('returns null when title is missing', async () => {
    expect(await extractJobPosting('<!doctype html><html><body></body></html>', 'https://e.com')).toBeNull();
  });

  it('returns null on empty input', async () => {
    expect(await extractJobPosting('', 'https://e.com')).toBeNull();
  });
});
