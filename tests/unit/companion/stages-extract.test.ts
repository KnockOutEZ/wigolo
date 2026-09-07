import { describe, it, expect, vi } from 'vitest';

import type { ExtractInput, ExtractOutput } from '../../../src/types.js';
import { isDatabaseInitialized } from '../../../src/cache/db.js';
import { SmartRouter, type HttpClient } from '../../../src/fetch/router.js';
import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';
import { httpFetch } from '../../../src/fetch/http-client.js';
import { getConfig } from '../../../src/config.js';
import { handleExtract } from '../../../src/tools/extract.js';
import {
  createExtractStage,
  ExtractStageError,
} from '../../../src/companion/stages.js';

/**
 * The session-targeted extract stage (`wigolo/companion-stages`), beside the three in
 * `stages.test.ts` / `stages-search.test.ts`.
 *
 * WHY THE ASSERTION IS A DIFFERENTIAL AND NOT A SHAPE CHECK. The app's session path used to serve
 * `metadata` alone and refuse the other five modes as data; the whole point of this stage is that a
 * session-targeted extract answers what the ephemeral extract answers. A test that pinned expected
 * payloads per mode would agree with itself forever and go green the day one path grows a field the
 * other does not. So every mode below runs BOTH paths over ONE fixture and deep-equals them: the
 * assertion fails on drift in either direction, including drift introduced by the ephemeral side.
 *
 * `response_time_ms` is the one field that legitimately differs — it is a wall-clock measurement
 * taken twice — so it is asserted to be present and numeric on both, then normalised away. Nothing
 * else is excluded.
 */

/**
 * One page carrying a source for all six modes at once: a heading for `selector`, a `<table>` for
 * `tables`, title/description/og for `metadata`, prices and a definition list for `structured`,
 * schema-matchable fields for `schema`, and — for `brand` — two CSS brand variables plus a
 * JSON-LD Organization. Two colours is deliberate: `extractBrandAsync` only reaches for the logo
 * image when the CSS variables surface fewer than two, so this fixture keeps the whole suite off
 * the network without stubbing the image fetcher out of the comparison.
 */
const FIXTURE = `<!doctype html>
<html lang="en">
<head>
  <title>Northwind Pricing</title>
  <meta name="description" content="Plans and prices for Northwind." />
  <meta property="og:title" content="Northwind Pricing" />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://northwind.example/pricing" />
  <style>:root { --brand-primary: #1b3a6b; --brand-secondary: #d99b21; }</style>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Northwind","url":"https://northwind.example"}
  </script>
</head>
<body>
  <h1 class="page-title">Northwind Pricing</h1>
  <p>Simple plans, billed monthly.</p>
  <table>
    <caption>Plans</caption>
    <thead><tr><th>Plan</th><th>Price</th><th>Seats</th></tr></thead>
    <tbody>
      <tr><td>Starter</td><td>$0</td><td>1</td></tr>
      <tr><td>Team</td><td>$29</td><td>10</td></tr>
      <tr><td>Scale</td><td>$99</td><td>50</td></tr>
    </tbody>
  </table>
  <dl>
    <dt>Support</dt><dd>Email, business hours</dd>
    <dt>Region</dt><dd>eu-west-1</dd>
  </dl>
</body>
</html>`;

/** A page with no `<table>` and no grid-shaped divs — the `no_tables_detected` refusal's source. */
const TABLELESS = '<html><head><title>Empty</title></head><body><p>Nothing tabular here.</p></body></html>';

/**
 * The ephemeral path's own collaborator, built the way core builds it. It is never reached on a
 * raw-HTML call — `resolveHtml` only fetches when a `url` is present — but `handleExtract` takes
 * it, and handing it a stub would make the control arm a different function from the one the
 * ephemeral tool runs.
 */
function buildRouter(): SmartRouter {
  const httpClient: HttpClient = { fetch: (url, init) => httpFetch(url, init) };
  return new SmartRouter(
    httpClient,
    new MultiBrowserPool({
      browserTypes: getConfig().browserTypes,
      selectionStrategy: 'round-robin',
    }),
  );
}

/** Strip the one field that is a fresh measurement on each call, asserting it was there first. */
function normalise(out: ExtractOutput, label: string): Omit<ExtractOutput, 'response_time_ms'> {
  expect(typeof out.response_time_ms, `${label} reported no response_time_ms`).toBe('number');
  const { response_time_ms: _ignored, ...rest } = out;
  return rest;
}

async function ephemeral(input: Omit<ExtractInput, 'url'>): Promise<ExtractOutput> {
  const result = await handleExtract({ ...input }, buildRouter(), 'agent');
  if (!result.ok) throw new Error(`ephemeral path refused: ${result.error} — ${result.error_reason}`);
  return result.data;
}

/** Every mode the ephemeral extract serves, each with the input that mode needs. */
const MODES: { name: string; input: Omit<ExtractInput, 'url' | 'html'> }[] = [
  { name: 'selector', input: { mode: 'selector', css_selector: 'h1.page-title' } },
  { name: 'selector (multiple)', input: { mode: 'selector', css_selector: 'td', multiple: true } },
  { name: 'tables', input: { mode: 'tables' } },
  { name: 'metadata', input: { mode: 'metadata' } },
  { name: 'structured', input: { mode: 'structured' } },
  { name: 'brand', input: { mode: 'brand' } },
  {
    name: 'schema',
    input: {
      mode: 'schema',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
];

describe('createExtractStage', () => {
  for (const { name, input } of MODES) {
    it(`answers mode '${name}' with exactly what the ephemeral extract answers`, async () => {
      const stage = createExtractStage();
      const viaStage = await stage({ html: FIXTURE, ...input });
      const viaEphemeral = await ephemeral({ html: FIXTURE, ...input });

      expect(normalise(viaStage, 'stage')).toEqual(normalise(viaEphemeral, 'ephemeral'));
      // A payload that is empty on both sides would satisfy the equality above while proving
      // nothing about either path, so the mode has to have actually produced something.
      expect(JSON.stringify(viaStage.data)?.length ?? 0).toBeGreaterThan(2);
      expect(viaStage.mode).toBe(input.mode);
    });
  }

  it('defaults to metadata when no mode is named, as the ephemeral path does', async () => {
    const stage = createExtractStage();
    const viaStage = await stage({ html: FIXTURE });
    expect(normalise(viaStage, 'stage')).toEqual(
      normalise(await ephemeral({ html: FIXTURE }), 'ephemeral'),
    );
    expect(viaStage.mode).toBe('metadata');
  });

  it('reports the live page as source_url without fetching it', async () => {
    const stage = createExtractStage();
    const named = await stage({
      html: FIXTURE,
      mode: 'metadata',
      source_url: 'https://northwind.example/pricing',
    });
    const anonymous = await stage({ html: FIXTURE, mode: 'metadata' });

    // The address is the ONLY thing it changes: the host already holds the DOM, so naming the page
    // is provenance, never a second read of it.
    expect(named.source_url).toBe('https://northwind.example/pricing');
    expect(anonymous.source_url).toBeUndefined();
    expect(normalise({ ...named, source_url: undefined }, 'named')).toEqual(
      normalise(anonymous, 'anonymous'),
    );
  });

  it('crosses max_tokens_out unreshaped, so the caller’s budget is the one that is spent', async () => {
    const stage = createExtractStage();
    const clamped = await stage({ html: FIXTURE, mode: 'tables', max_tokens_out: 40 });
    const unclamped = await stage({ html: FIXTURE, mode: 'tables' });

    expect(clamped.truncated).toBe(true);
    expect(clamped.warnings?.join(' ')).toContain('max_tokens_out');
    expect(JSON.stringify(clamped.data).length).toBeLessThan(
      JSON.stringify(unclamped.data).length,
    );
    expect(normalise(clamped, 'clamped')).toEqual(
      normalise(await ephemeral({ html: FIXTURE, mode: 'tables', max_tokens_out: 40 }), 'ephemeral'),
    );
  });

  it('throws a typed refusal rather than an empty payload the caller cannot read', async () => {
    const stage = createExtractStage();
    // `[]` is a legitimate extract answer, so a refusal that arrived as one would be
    // indistinguishable from a page that genuinely had nothing — the same reason the search
    // stage throws.
    await expect(stage({ html: TABLELESS, mode: 'tables' })).rejects.toBeInstanceOf(
      ExtractStageError,
    );
    await expect(stage({ html: TABLELESS, mode: 'tables' })).rejects.toMatchObject({
      code: 'no_tables_detected',
    });
  });

  it('refuses a malformed request with the handler’s own code, not a generic failure', async () => {
    const stage = createExtractStage();
    await expect(
      // `selector` without a selector — the ephemeral handler's own input validation, reached
      // through the stage rather than re-implemented beside it.
      stage({ html: FIXTURE, mode: 'selector' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('opens no database — the host owns the handle, this module borrows it', async () => {
    const before = isDatabaseInitialized();
    const stage = createExtractStage();
    await stage({ html: FIXTURE, mode: 'metadata' });
    expect(isDatabaseInitialized()).toBe(before);
  });

  it('never navigates: a factory built and called does not reach the network', async () => {
    // The stage takes the DOM the host already settled, so there is no URL for it to resolve and
    // no SSRF surface to guard. Pinning it here is what keeps a later "just pass the url through"
    // from quietly turning this seam into a fetcher.
    const stage = createExtractStage();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await stage({ html: FIXTURE, mode: 'brand' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
