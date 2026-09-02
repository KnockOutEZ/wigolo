/**
 * PX2 RC exit gate — every network the measured arms are allowed to touch.
 *
 * Three local servers, one file, because they exist for one reason: the gate's
 * claim is that the ten tools run with nothing leaving the machine (A-212-11),
 * and a claim like that is only worth what the *absence* of an external host
 * makes it. A fixture site the fetch family reads, a stub search engine the
 * search family reads, and a recording front door for the accounts service so
 * the telemetry arm can count requests instead of reading code.
 *
 * Hand-rolled rather than shared: no reusable fixture-server helper exists in
 * this repo (`tests/e2e/fetch-tool.test.ts` stands its own up the same way), and
 * `tests/helpers/` is not this issue's territory.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface LocalServer {
  url: string;
  stop(): Promise<void>;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('local server did not bind a port'));
        return;
      }
      resolveUrl(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.closeAllConnections();
    server.close(() => resolveClose());
  });
}

export interface FixtureSite extends LocalServer {
  /** How many times the site has been asked for anything. */
  hits(): number;
  /** Replace a page's body — how the `diff` arm makes a second version. */
  setPage(path: string, html: string): void;
}

/**
 * The site the fetch family reads.
 *
 * WHY THE HOME PAGE'S LINKS SIT IN A PARAGRAPH. They were a `<ul>` first, and
 * the crawl arm reported `total_found: 1` — the content extractor reads a bare
 * list of short links as navigation boilerplate and drops it, so there was
 * nothing left for the crawler to follow and a "crawl" of one page passed for a
 * crawl. In prose they survive extraction, which is the shape a real article
 * links in anyway.
 *
 * WHAT EACH PAGE IS FOR. `crawl` needs links to follow and a `robots.txt` that
 * permits it; `extract` needs a table, a definition list and a JSON-LD block, or
 * structured extraction has nothing to find and a green assertion would only
 * mean "did not throw"; `diff` needs a page whose body can change between two
 * reads; `watch` needs a URL that resolves. `cache` needs nothing of its own —
 * it reports on what the earlier tools put there, which is exactly why it runs
 * last in the tool arm.
 */
export async function startFixtureSite(): Promise<FixtureSite> {
  let hits = 0;
  const pages = new Map<string, string>();

  pages.set('/', `<!doctype html><html><head><title>RC Fixture Home</title>
<meta name="description" content="The PX2 RC exit gate fixture site.">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Organization","name":"RC Fixture","url":"http://fixture.invalid"}
</script>
</head><body>
<main>
<h1>RC Fixture Home</h1>
<p>This page exists so the fetch family has something local to read during the PX2 RC exit gate.</p>
<p>It is deliberately wordy enough that a content extractor has a main block to find, a reranker has
tokens to score, and a diff has lines to compare. The subject is the activation gate: a fresh install
demands registration, registration is completed against a locally-run accounts service, and every one
of the ten tools then runs without a single request leaving this machine.</p>
<p>The rest of this site is reachable from here: the <a href="/pricing">pricing table</a> carries three
plans with prices and seat counts, the <a href="/glossary">glossary</a> defines the activation gate and
its grace window, and the <a href="/changelog">changelog</a> is the page whose body changes between two
reads so a diff has something to report.</p>
</main>
</body></html>`);

  pages.set('/pricing', `<!doctype html><html><head><title>RC Fixture Pricing</title></head><body>
<main>
<h1>Pricing</h1>
<table>
<thead><tr><th>Plan</th><th>Price</th><th>Seats</th></tr></thead>
<tbody>
<tr><td>Free</td><td>0</td><td>1</td></tr>
<tr><td>Team</td><td>20</td><td>10</td></tr>
<tr><td>Scale</td><td>60</td><td>50</td></tr>
</tbody>
</table>
</main>
</body></html>`);

  pages.set('/glossary', `<!doctype html><html><head><title>RC Fixture Glossary</title></head><body>
<main>
<h1>Glossary</h1>
<dl>
<dt>Activation gate</dt><dd>The check that refuses a tool run until the install is registered.</dd>
<dt>Grace window</dt><dd>Fourteen days measured from the last successful refresh.</dd>
<dt>Perpetual grant</dt><dd>An entitlement with no expiry, which survives an offline stretch.</dd>
</dl>
</main>
</body></html>`);

  pages.set('/changelog', `<!doctype html><html><head><title>RC Fixture Changelog</title></head><body>
<main><h1>Changelog</h1><p>Version one of this page.</p></main>
</body></html>`);

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    hits += 1;
    const path = (request.url ?? '/').split('?')[0];

    if (path === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('User-agent: *\nAllow: /\n');
      return;
    }

    const body = pages.get(path);
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });

  const url = await listen(server);
  return {
    url,
    hits: () => hits,
    setPage: (path, html) => { pages.set(path, html); },
    stop: () => close(server),
  };
}

export interface StubSearchEngine extends LocalServer {
  /** Every query the search family asked for, in order. */
  queries(): readonly string[];
}

/**
 * The search engine the search family reads.
 *
 * It answers the exact contract `SearxngClient` sends and parses:
 * `GET /search?q=…&format=json&pageno=1` in, `{results:[{title,url,content,
 * engine,engines,score}], query, number_of_results}` out. Results point at the
 * fixture site, so a pipeline that follows a result to read it stays local too —
 * which is what makes `research` and `agent` offline rather than merely quiet.
 */
export async function startStubSearchEngine(fixtureUrl: string): Promise<StubSearchEngine> {
  const queries: string[] = [];

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requested = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requested.pathname !== '/search') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    const query = requested.searchParams.get('q') ?? '';
    queries.push(query);

    const results = [
      {
        title: 'RC Fixture Home — the activation gate',
        url: `${fixtureUrl}/`,
        content:
          'A fresh install demands registration; registration completes against a locally-run ' +
          'accounts service; all ten tools then run with nothing leaving the machine.',
        engine: 'stub',
        engines: ['stub'],
        score: 1,
      },
      {
        title: 'RC Fixture Glossary — grace window and perpetual grant',
        url: `${fixtureUrl}/glossary`,
        content:
          'The grace window is fourteen days from the last successful refresh. A perpetual grant ' +
          'has no expiry and survives an offline stretch.',
        engine: 'stub',
        engines: ['stub'],
        score: 0.9,
      },
      {
        title: 'RC Fixture Pricing — plans and seats',
        url: `${fixtureUrl}/pricing`,
        content: 'Free, Team and Scale plans with prices and seat counts in a table.',
        engine: 'stub',
        engines: ['stub'],
        score: 0.8,
      },
    ];

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results, query, number_of_results: results.length }));
  });

  const url = await listen(server);
  return { url, queries: () => queries, stop: () => close(server) };
}

export interface RecordingProxy extends LocalServer {
  /** Requests seen on `POST /telemetry/batch`. */
  telemetryRequests(): readonly { method: string; bodyBytes: number }[];
  /** Every path the client asked this front door for. */
  paths(): readonly string[];
  reset(): void;
  /**
   * Point the front door at a different service, keeping this URL.
   *
   * The grace arm restarts the accounts service on a back-dated clock, which
   * takes a new port. Re-pointing rather than re-creating is what keeps
   * `WIGOLO_ACCOUNTS_URL` byte-identical across that restart, so the arm changes
   * exactly one variable — what time the service thinks it is — instead of also
   * moving the address the client trusts.
   */
  setTarget(url: string): void;
}

/**
 * The accounts service's front door, with a counter on the telemetry route.
 *
 * WHY A PROXY AND NOT A SEPARATE ENDPOINT. Telemetry batches go to the account
 * service itself — `POST /telemetry/batch` on the same host the client already
 * holds — and `WIGOLO_TELEMETRY_ENDPOINT` is deprecated and ignored, so there is
 * no env that could point telemetry somewhere else while leaving registration
 * working. Sitting in front of the real service is therefore the only place from
 * which "zero requests reached the telemetry endpoint" can be OBSERVED rather
 * than argued: registration, refresh and entitlement calls pass through and
 * succeed, and the batch route is counted.
 */
export async function startRecordingProxy(targetUrl: string): Promise<RecordingProxy> {
  let telemetry: { method: string; bodyBytes: number }[] = [];
  let paths: string[] = [];
  let target = targetUrl;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '/';
    paths.push(path);

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);

        if (path.startsWith('/telemetry/batch')) {
          telemetry.push({ method: request.method ?? 'GET', bodyBytes: body.byteLength });
        }

        try {
          const forwarded = await fetch(`${target}${path}`, {
            method: request.method,
            headers: forwardableHeaders(request),
            ...(body.byteLength > 0 ? { body } : {}),
            signal: AbortSignal.timeout(30_000),
          });
          const payload = Buffer.from(await forwarded.arrayBuffer());
          response.writeHead(forwarded.status, {
            'content-type': forwarded.headers.get('content-type') ?? 'application/json',
          });
          response.end(payload);
        } catch (error) {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: String(error) }));
        }
      })();
    });
  });

  const url = await listen(server);
  return {
    url,
    telemetryRequests: () => telemetry,
    paths: () => paths,
    reset: () => { telemetry = []; paths = []; },
    setTarget: (next: string) => { target = next; },
    stop: () => close(server),
  };
}

/**
 * Hop-by-hop and length headers are dropped; `authorization` is NOT.
 *
 * The batch route is Bearer-authenticated, so a proxy that stripped the header
 * would turn every telemetry POST into a 401 and the ON arm would record a
 * request that could never have succeeded — a flip-test that proves the counter
 * works but not that telemetry does.
 */
function forwardableHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lowered = name.toLowerCase();
    if (lowered === 'host' || lowered === 'connection' || lowered === 'content-length') continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}
