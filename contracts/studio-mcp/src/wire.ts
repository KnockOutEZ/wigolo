/**
 * The wire-level invariants of the `studio_*` MCP surface, as pure predicates.
 *
 * They live here rather than inline in the conformance spec for one reason: an invariant written as a
 * chain of `expect()` calls inside an `it()` can only ever be checked by running a whole Studio, so it
 * cannot itself be tested. These can — `tests/wire.test.ts` feeds each one the shapes it must accept
 * and the shapes it must reject, which is what stops the conformance suite from passing because its
 * checks are vacuous.
 *
 * Every function returns a list of human-readable violations rather than a boolean, because a
 * conformance failure has to say WHICH property broke against WHICH observed value. "false" is not a
 * conformance report.
 */

/** The MCP tool-result envelope every studio tool answers in. */
export interface StudioToolResultEnvelope {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Unwrap `content[0].text` as JSON.
 *
 * This unwrap IS part of the contract, not test plumbing: every studio tool answers with its payload
 * JSON-serialized into a single text content block (the proxy path passes the host's envelope back
 * verbatim, so both the in-process and the forwarded shapes are this one). A conforming endpoint that
 * answered with, say, a structured-content block would break every agent written against it, so a
 * throw here is a conformance failure and is worded as one.
 */
export function toolResultBody(result: unknown): Record<string, unknown> {
  const env = result as StudioToolResultEnvelope | undefined;
  const block = env?.content?.[0];
  if (!block || typeof block.text !== 'string') {
    throw new Error(`tool result is not the contract envelope {content:[{type,text}]}: ${JSON.stringify(result)?.slice(0, 400)}`);
  }
  try {
    return JSON.parse(block.text) as Record<string, unknown>;
  } catch {
    throw new Error(`tool result content[0].text is not JSON: ${block.text.slice(0, 400)}`);
  }
}

/**
 * The discovery handle must point at loopback.
 *
 * A Studio endpoint carries a bearer that grants an agent full drive of a browser holding the human's
 * logged-in sessions. Binding it anywhere reachable off-box is not a hardening nit, it is remote
 * control of the human's identity, so "loopback" is asserted on the published endpoint rather than
 * trusted from the binding code. IPv6 loopback counts; a hostname that merely LOOKS local does not,
 * because names resolve and `localtest.me`-style names resolve outward.
 */
export function loopbackEndpointErrors(endpoint: string): string[] {
  const errs: string[] = [];
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return [`endpoint is not a URL: ${JSON.stringify(endpoint)}`];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') errs.push(`endpoint protocol is ${url.protocol}, expected http(s)`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!isLoopback) errs.push(`endpoint host ${host} is not loopback`);
  return errs;
}

/**
 * A refusal must be self-describing.
 *
 * `error_reason` alone tells an agent that something failed and nothing about what to do next, so an
 * agent that receives one either stops or retries into the same wall. `hint` is the field that makes
 * the difference, and it is required on EVERY refusal.
 *
 * `not_holder` additionally carries `currentEpoch`. That one is not politeness: control is epoch'd, and
 * an agent that was preempted needs the live epoch to resync its view of whose turn it is. It is also
 * the specific field a naive "serialize just {error_reason, hint}" refusal helper drops — which is why
 * the act path serializes the host's full result both ways instead of funnelling through that helper.
 */
export function refusalContractErrors(body: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const reason = body.error_reason;
  if (typeof reason !== 'string' || reason.length === 0) {
    return [`refusal has no error_reason: ${JSON.stringify(body).slice(0, 300)}`];
  }
  if (typeof body.hint !== 'string' || (body.hint as string).length === 0) {
    errs.push(`refusal ${reason} carries no hint (keys: ${Object.keys(body).join(',')})`);
  }
  if (reason === 'not_holder' && typeof body.currentEpoch !== 'number') {
    errs.push(`not_holder refusal dropped currentEpoch (keys: ${Object.keys(body).join(',')})`);
  }
  return errs;
}

/**
 * Page-derived results must arrive fenced.
 *
 * `trusted` is compared to `false` with strict equality on purpose. The regression this guards is a
 * FIELD being dropped somewhere on the round trip, and a dropped field reads as `undefined` — which is
 * falsy, so `expect(body.trusted).toBeFalsy()` would pass on exactly the broken shape. The same is true
 * of `untrusted_notice`: it has to be a non-empty string, because an absent instruction-channel notice
 * and a present one are the whole difference between page text arriving as data and arriving as
 * something an agent might obey.
 */
export function untrustedFenceErrors(body: Record<string, unknown>): string[] {
  const errs: string[] = [];
  if (body.trusted !== false) errs.push(`trusted is ${JSON.stringify(body.trusted)}, expected the literal false (a dropped field reads as undefined and must not pass)`);
  if (typeof body.untrusted_notice !== 'string' || (body.untrusted_notice as string).length === 0) {
    errs.push(`untrusted_notice is ${JSON.stringify(body.untrusted_notice)}, expected a non-empty instruction-channel notice`);
  }
  return errs;
}

/** An advertised tool, as `listTools()` returns it. */
export interface AdvertisedTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string };
}

/**
 * Every advertised tool must be USABLE from its advertisement alone: a name an agent can call, a
 * description that says what it does, and an object input schema it can build arguments against. A
 * tool advertised with an empty description is discoverable and unusable, which is worse than absent
 * because the agent will still try.
 */
export function advertisedToolErrors(tool: AdvertisedTool): string[] {
  const errs: string[] = [];
  if (typeof tool.description !== 'string' || tool.description.trim().length === 0) errs.push(`${tool.name} has no description`);
  if (tool.inputSchema?.type !== 'object') errs.push(`${tool.name} inputSchema.type is ${JSON.stringify(tool.inputSchema?.type)}, expected 'object'`);
  return errs;
}
