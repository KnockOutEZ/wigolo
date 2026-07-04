import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  extractWithLocalLlm,
  MAX_MARKDOWN_CHARS,
} from '../../../../../src/extraction/v1/local-llm.js';
import type { LocalModelTier } from '../../../../../src/integrations/cloud/llm/local-tier.js';

const TIER: LocalModelTier = {
  available: true,
  endpoint: 'http://localhost:1234',
  model: 'test-model',
  source: 'auto',
};

// A page whose pricing lives in a real <table>: extractStructured surfaces it as
// a structured table, and the pre-extraction (NOT raw HTML) is what must reach
// the model. The raw markup carries a boilerplate marker string that must NOT
// leak into the prompt when the deterministic brief is sent instead.
const HTML = `
<!doctype html>
<html><body>
<nav>RAW_HTML_NAV_MARKER</nav>
<h1>Acme Pricing</h1>
<table>
  <tr><th>Plan</th><th>Price</th></tr>
  <tr><td>Starter</td><td>$10</td></tr>
  <tr><td>Pro</td><td>$30</td></tr>
</table>
<p>Choose the plan that fits your team.</p>
</body></html>
`;

const ORIGINAL_PROVIDER = process.env['WIGOLO_LLM_PROVIDER'];
const ORIGINAL_MODEL = process.env['WIGOLO_LLM_MODEL'];

function jsonResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('extractWithLocalLlm — pre-extraction prompt over the local tier', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env['WIGOLO_LLM_PROVIDER'];
    delete process.env['WIGOLO_LLM_MODEL'];
  });

  afterEach(() => {
    if (ORIGINAL_PROVIDER === undefined) delete process.env['WIGOLO_LLM_PROVIDER'];
    else process.env['WIGOLO_LLM_PROVIDER'] = ORIGINAL_PROVIDER;
    if (ORIGINAL_MODEL === undefined) delete process.env['WIGOLO_LLM_MODEL'];
    else process.env['WIGOLO_LLM_MODEL'] = ORIGINAL_MODEL;
  });

  it('builds the prompt from the deterministic pre-extraction + markdown, NOT raw HTML', async () => {
    // WHY: the core bug this slice fixes — the model used to receive a ~50KB raw
    // HTML slice. It must instead receive the structured brief (tables/lists/kv)
    // plus trimmed page markdown, so the model reasons over already-extracted
    // structure and never re-parses noisy markup.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse('{"plan":"Pro"}'));

    await extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: HTML,
      url: 'https://acme.example/pricing',
      tier: TIER,
    });

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    const promptText = body.messages.map((m: { content: string }) => m.content).join('\n');
    // Structured facts from extractStructured are present …
    expect(promptText).toContain('Starter');
    expect(promptText).toContain('$10');
    expect(promptText).toContain('Pro');
    // … but the raw HTML tags / boilerplate nav marker are NOT.
    expect(promptText).not.toContain('RAW_HTML_NAV_MARKER');
    expect(promptText).not.toContain('<table>');
    expect(promptText).not.toContain('<!doctype');
  });

  it('routes to the tier endpoint + model (not the WIGOLO_LLM_PROVIDER env)', async () => {
    // WHY: the endpoint/model come from the C0 resolveLocalModelTier result, so
    // a keyless run with only WIGOLO_LOCAL_LLM=auto reaches the local server even
    // though WIGOLO_LLM_PROVIDER is unset.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse('{"plan":"Pro"}'));

    await extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: HTML,
      url: 'u',
      tier: TIER,
    });

    expect(fetchSpy.mock.calls[0]![0]).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.model).toBe('test-model');
  });

  it('does not leak WIGOLO_LLM_PROVIDER into the ambient env after the call', async () => {
    // WHY: the endpoint bridge sets WIGOLO_LLM_PROVIDER for the single runLlmJson
    // call; it MUST restore the prior value so no other code path sees a mutated
    // provider (byte-for-byte guarantee for everything downstream).
    process.env['WIGOLO_LLM_PROVIDER'] = 'anthropic';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse('{"plan":"Pro"}'));

    await extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: HTML,
      url: 'u',
      tier: TIER,
    });

    expect(process.env['WIGOLO_LLM_PROVIDER']).toBe('anthropic');
  });

  it('does not corrupt WIGOLO_LLM_PROVIDER under two concurrent calls', async () => {
    // WHY: threading the endpoint through process.env is not concurrency-safe.
    // With two calls in flight, call B captures A's already-mutated env as its
    // baseline; B's restore then leaves WIGOLO_LLM_PROVIDER durably pointing at
    // the local endpoint, silently rerouting cloud→local for every downstream
    // subsystem (search answer synthesis, research/agent synthesis) for the rest
    // of the process. The tier endpoint MUST be threaded per-call so no ambient
    // env is ever mutated — this asserts the value is unchanged after BOTH
    // concurrent calls resolve.
    process.env['WIGOLO_LLM_PROVIDER'] = 'anthropic';

    // A stalling fetch keeps both calls in flight simultaneously so the
    // set/restore windows overlap — the exact race the env bridge lost.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate;
      return jsonResponse('{"plan":"Pro"}');
    });

    const a = extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: HTML,
      url: 'a',
      tier: TIER,
    });
    const b = extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: HTML,
      url: 'b',
      tier: TIER,
    });
    // Both are parked on the gate — env, if mutated, is currently corrupt.
    release();
    await Promise.all([a, b]);

    expect(process.env['WIGOLO_LLM_PROVIDER']).toBe('anthropic');
  });

  it('trims the page markdown to a bounded budget', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse('{"plan":"Pro"}'));
    const bigParagraph = '<p>' + 'x'.repeat(MAX_MARKDOWN_CHARS * 3) + '</p>';
    const bigHtml = `<html><body><h1>Big</h1>${bigParagraph}</body></html>`;

    await extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: bigHtml,
      url: 'u',
      tier: TIER,
    });

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    const promptText = body.messages.map((m: { content: string }) => m.content).join('\n');
    // The whole prompt (brief + budgeted markdown + instructions) is bounded; a
    // 3×-budget paragraph cannot dump the entire page into the context.
    expect(promptText.length).toBeLessThan(MAX_MARKDOWN_CHARS * 2);
  });

  it('keeps substantive content that sits past a large boilerplate block in the prompt', async () => {
    // WHY: real pages bury the schema-relevant content (pricing) under a large
    // nav/hero block that easily exceeds a raw-markdown char budget. A naive
    // slice-from-the-top drops the pricing entirely and the model hallucinates.
    // The prompt must use main-content extraction so the substantive region
    // survives the budget even when it appears late in the raw document.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse('{"plan":"Pro"}'));
    const bigNav =
      '<ul>' +
      Array.from(
        { length: 150 },
        (_, i) => `<li><a href="/docs/${i}">Documentation section ${i}</a></li>`,
      ).join('') +
      '</ul>';
    const article =
      '<article><h1>Pricing Plans</h1>' +
      Array.from(
        { length: 8 },
        (_, i) =>
          `<p>Our pricing is designed for teams of every size and this is descriptive paragraph number ${i} explaining the value proposition in detail.</p>`,
      ).join('') +
      '<section><h2>Pro</h2><p>PRICESIGNAL2999 per month for growing teams that need advanced analytics and priority support.</p></section></article>';
    const buriedHtml = `<!doctype html><html><body>
      <header><nav>${bigNav}</nav></header>
      <main>${article}</main>
      <footer>copyright</footer>
    </body></html>`;

    await extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: buriedHtml,
      url: 'https://x.test/pricing',
      tier: TIER,
    });

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    const promptText = body.messages.map((m: { content: string }) => m.content).join('\n');
    // The buried pricing signal reaches the model despite the giant nav block …
    expect(promptText).toContain('PRICESIGNAL2999');
    // … and the boilerplate nav links do NOT flood the bounded context.
    expect(promptText).not.toContain('Documentation section 0');
  });

  it('returns the parsed+validated JSON object on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(JSON.stringify({ plan: 'Pro', price: '$30' })),
    );
    const result = await extractWithLocalLlm({
      schema: {
        type: 'object',
        properties: { plan: { type: 'string' }, price: { type: 'string' } },
      },
      html: HTML,
      url: 'u',
      tier: TIER,
    });
    expect(result).toEqual({ plan: 'Pro', price: '$30' });
  });

  it('returns null (does NOT throw) on invalid JSON so the caller falls back deterministically', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse('this is not json'),
    );
    const result = await extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: HTML,
      url: 'u',
      tier: TIER,
    });
    expect(result).toBeNull();
  });

  it('returns null on a non-200 endpoint response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const result = await extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: HTML,
      url: 'u',
      tier: TIER,
    });
    expect(result).toBeNull();
  });

  it('returns null on a transport error / timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'));
    const result = await extractWithLocalLlm({
      schema: { type: 'object', properties: { plan: { type: 'string' } } },
      html: HTML,
      url: 'u',
      tier: TIER,
    });
    expect(result).toBeNull();
  });
});
