import { parseHTML } from 'linkedom';
import { extractJsonLd } from '../../jsonld.js';

export interface JobPostingData {
  title: string;
  hiringOrganization?: string;
  jobLocation?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string;
  baseSalary?: string;
  description?: string;
  url: string;
}

export async function extractJobPosting(html: string, url: string): Promise<JobPostingData | null> {
  if (!html) return null;

  const fromJsonLd = tryJsonLd(html, url);
  if (fromJsonLd) return fromJsonLd;

  return tryMetaFallback(html, url);
}

function tryJsonLd(html: string, url: string): JobPostingData | null {
  let blocks: Record<string, unknown>[];
  try {
    blocks = extractJsonLd(html);
  } catch {
    return null;
  }

  const job = blocks.find((block) => typeIncludes(block['@type'], 'jobposting'));
  if (!job) return null;

  const title = stringField(job['title']);
  if (!title) return null;

  const data: JobPostingData = {
    title,
    url,
  };
  const hiringOrganization = readOrganization(job['hiringOrganization']);
  if (hiringOrganization) data.hiringOrganization = hiringOrganization;
  const jobLocation = readLocation(job['jobLocation']);
  if (jobLocation) data.jobLocation = jobLocation;
  const datePosted = stringField(job['datePosted']);
  if (datePosted) data.datePosted = datePosted;
  const validThrough = stringField(job['validThrough']);
  if (validThrough) data.validThrough = validThrough;
  const employmentType = readEmploymentType(job['employmentType']);
  if (employmentType) data.employmentType = employmentType;
  const baseSalary = readBaseSalary(job['baseSalary']);
  if (baseSalary) data.baseSalary = baseSalary;
  const description = stringField(job['description']);
  if (description) data.description = description;
  return data;
}

function tryMetaFallback(html: string, url: string): JobPostingData | null {
  let document: Document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return null;
  }

  const datePostedMeta = metaContent(document, 'meta[property="job:date_posted"]');
  const validThroughMeta = metaContent(document, 'meta[property="job:valid_through"]');
  const locationMeta = metaContent(document, 'meta[property="job:location"]');
  const organizationMeta = metaContent(document, 'meta[property="job:hiring_organization"]');
  const description = metaContent(document, 'meta[property="og:description"]');

  let title: string | undefined;
  const h1 = document.querySelector('h1');
  const h1Text = h1?.textContent?.trim();
  if (h1Text) title = h1Text;
  if (!title) {
    title = metaContent(document, 'meta[property="og:title"]');
  }

  if (!title) return null;

  const data: JobPostingData = {
    title,
    url,
  };
  if (organizationMeta) data.hiringOrganization = organizationMeta;
  if (locationMeta) data.jobLocation = locationMeta;
  if (datePostedMeta) data.datePosted = datePostedMeta;
  if (validThroughMeta) data.validThrough = validThroughMeta;
  if (description) data.description = description;
  return data;
}

function metaContent(document: Document, selector: string): string | undefined {
  const el = document.querySelector(selector);
  const content = el?.getAttribute('content')?.trim();
  return content && content.length > 0 ? content : undefined;
}

function typeIncludes(raw: unknown, want: string): boolean {
  const target = want.toLowerCase();
  if (typeof raw === 'string') return normalizeType(raw) === target;
  if (Array.isArray(raw)) {
    return raw.some((entry) => typeof entry === 'string' && normalizeType(entry) === target);
  }
  return false;
}

function normalizeType(raw: string): string {
  const tail = raw.split(/[/#:]/).pop() ?? raw;
  return tail.toLowerCase();
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOrganization(value: unknown): string | undefined {
  if (typeof value === 'string') return stringField(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const name = readOrganization(entry);
      if (name) return name;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>)['name'];
    if (typeof name === 'string') return stringField(name);
  }
  return undefined;
}

function readLocation(value: unknown): string | undefined {
  if (typeof value === 'string') return stringField(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const loc = readLocation(entry);
      if (loc) return loc;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const name = stringField(obj['name']);
    if (name) return name;
    const address = obj['address'];
    if (typeof address === 'string') return stringField(address);
    if (address && typeof address === 'object') {
      const aobj = address as Record<string, unknown>;
      const parts = [
        stringField(aobj['streetAddress']),
        stringField(aobj['addressLocality']),
        stringField(aobj['addressRegion']),
        stringField(aobj['addressCountry']),
      ].filter((s): s is string => Boolean(s));
      if (parts.length > 0) return parts.join(', ');
    }
  }
  return undefined;
}

function readEmploymentType(value: unknown): string | undefined {
  if (typeof value === 'string') return stringField(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === 'string' ? stringField(entry) : undefined))
      .filter((s): s is string => Boolean(s));
    if (parts.length > 0) return parts.join(', ');
  }
  return undefined;
}

function readBaseSalary(value: unknown): string | undefined {
  if (typeof value === 'string') return stringField(value);
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const currency = stringField(obj['currency']);
    const valueField = obj['value'];
    if (valueField && typeof valueField === 'object') {
      const vobj = valueField as Record<string, unknown>;
      const minValue = numberField(vobj['minValue']);
      const maxValue = numberField(vobj['maxValue']);
      const unitText = stringField(vobj['unitText']);
      if (minValue !== undefined && maxValue !== undefined) {
        const range = `${minValue}-${maxValue}`;
        const withCurrency = currency ? `${currency} ${range}` : range;
        return unitText ? `${withCurrency}/${unitText}` : withCurrency;
      }
      const single = numberField(vobj['value']);
      if (single !== undefined) {
        const withCurrency = currency ? `${currency} ${single}` : String(single);
        return unitText ? `${withCurrency}/${unitText}` : withCurrency;
      }
    }
    if (typeof valueField === 'number') {
      return currency ? `${currency} ${valueField}` : String(valueField);
    }
    if (typeof valueField === 'string') {
      const trimmed = stringField(valueField);
      if (trimmed) return currency ? `${currency} ${trimmed}` : trimmed;
    }
  }
  return undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}
