import { describe, it, expect } from 'vitest';
import {
  DURATION_BUCKETS,
  ENGINE_IDS,
  ERROR_CLASSES,
  EVENT_NAMES,
  EVENT_NAME_PATTERN,
  EVENT_SCHEMA,
  SURFACES,
  TOOL_NAMES,
  UPTIME_BUCKETS,
  durationBucket,
  isValidEvent,
  uptimeBucket,
  type PropSpec,
  type TelemetryEvent,
} from '../../../src/telemetry/events.js';

/**
 * The Never list — page content, markdown, query text, full URLs, credentials, file paths —
 * is enforced by the SHAPE of the dictionary, not by review. These tests are the proof: they
 * walk every event and every prop and assert that no prop is capable of carrying an
 * arbitrary string. If a future slice adds a free-text prop, this file goes red before the
 * value ever reaches a queue file.
 */
describe('closed event dictionary', () => {
  const ALLOWED_KINDS = new Set<PropSpec['kind']>(['enum', 'boolean', 'domain']);

  it('ships exactly the six events the spec names', () => {
    expect([...EVENT_NAMES].sort()).toEqual([
      'daemon.uptime',
      'fetch.blocked',
      'fetch.tier_escalated',
      'search.engine_failure',
      'tool.error',
      'tool.run',
    ]);
  });

  it('gives every event a wire-legal name', () => {
    for (const name of EVENT_NAMES) {
      expect(EVENT_NAME_PATTERN.test(name), name).toBe(true);
    }
  });

  it('admits no prop that carries an arbitrary string', () => {
    for (const [event, props] of Object.entries(EVENT_SCHEMA)) {
      expect(Object.keys(props).length, `${event} has props`).toBeGreaterThan(0);
      for (const [prop, spec] of Object.entries(props)) {
        expect(ALLOWED_KINDS.has(spec.kind), `${event}.${prop} kind=${spec.kind}`).toBe(true);
        if (spec.kind === 'enum') {
          // A closed value list, and a non-empty one — an empty enum would admit nothing,
          // but a `values: string[]` typed as open would admit everything.
          expect(spec.values.length, `${event}.${prop}`).toBeGreaterThan(0);
          for (const value of spec.values) expect(typeof value).toBe('string');
        }
      }
    }
  });

  it('has no prop whose name suggests free text', () => {
    // Belt and braces on the kind walk: catches a prop that was given a `domain` kind to
    // sneak past it while being named for something the Never list forbids.
    const forbidden = /(message|msg|text|query|url|path|content|body|title|reason|detail)/i;
    for (const [event, props] of Object.entries(EVENT_SCHEMA)) {
      for (const prop of Object.keys(props)) {
        expect(forbidden.test(prop), `${event}.${prop}`).toBe(false);
      }
    }
  });

  it('carries error classes and never an error message', () => {
    expect([...ERROR_CLASSES].sort()).toEqual([
      'blocked',
      'dns',
      'http_4xx',
      'http_5xx',
      'internal',
      'invalid_input',
      'network',
      'timeout',
    ]);
    for (const props of Object.values(EVENT_SCHEMA)) {
      expect(Object.keys(props)).not.toContain('message');
      expect(Object.keys(props)).not.toContain('error_message');
    }
  });

  it('names all ten tools and the four surfaces', () => {
    expect(TOOL_NAMES).toHaveLength(10);
    expect([...SURFACES]).toEqual(['mcp', 'rest', 'cli', 'repl']);
  });

  it('keeps an `other` engine id so a new engine can never become free text', () => {
    expect(ENGINE_IDS).toContain('other');
  });
});

describe('isValidEvent', () => {
  const good: TelemetryEvent = {
    name: 'tool.run',
    props: { tool: 'search', surface: 'mcp', ok: true, duration_bucket: 'lt_500ms' },
  };

  it('accepts every event the dictionary declares', () => {
    const samples: TelemetryEvent[] = [
      good,
      { name: 'tool.error', props: { tool: 'fetch', surface: 'cli', error_class: 'timeout' } },
      { name: 'fetch.blocked', props: { domain: 'example.com', signal: 'challenge' } },
      { name: 'fetch.tier_escalated', props: { to_tier: 'browser' } },
      { name: 'search.engine_failure', props: { engine: 'duckduckgo', error_class: 'http_5xx' } },
      { name: 'daemon.uptime', props: { bucket: 'lt_8h' } },
    ];
    for (const sample of samples) expect(isValidEvent(sample), sample.name).toBe(true);
    // Every declared event is covered by a sample.
    expect(samples.map((s) => s.name).sort()).toEqual([...EVENT_NAMES].sort());
  });

  it('rejects an unlisted event name', () => {
    expect(isValidEvent({ name: 'tool.ran', props: {} })).toBe(false);
  });

  it('rejects an enum prop carrying free text', () => {
    expect(isValidEvent({ ...good, props: { ...good.props, tool: 'rm -rf /' } })).toBe(false);
    expect(isValidEvent({ ...good, props: { ...good.props, duration_bucket: '431ms' } })).toBe(false);
  });

  it('rejects an extra prop rather than silently stripping it', () => {
    // Stripping would put an event on the wire that nobody wrote; rejecting keeps the
    // reported shape and the declared shape the same object.
    expect(isValidEvent({ ...good, props: { ...good.props, query: 'how to leak data' } })).toBe(false);
  });

  it('rejects a missing prop', () => {
    expect(isValidEvent({ name: 'daemon.uptime', props: {} })).toBe(false);
  });

  it('rejects a boolean prop that is not a boolean', () => {
    expect(isValidEvent({ ...good, props: { ...good.props, ok: 'true' } })).toBe(false);
  });

  it('rejects a domain prop carrying anything but a bare registrable domain', () => {
    const forbidden = [
      'https://www.example.com/private/report.pdf?token=abc',
      'www.example.com',
      'example.com/path',
      'example.com:443',
      '/Users/someone/notes.md',
      'a query with spaces',
      '192.168.1.7',
      'localhost',
      'co.uk',
    ];
    for (const domain of forbidden) {
      expect(isValidEvent({ name: 'fetch.blocked', props: { domain, signal: 'http_403' } }), domain).toBe(false);
    }
  });

  it('rejects non-objects', () => {
    for (const junk of [null, undefined, 'tool.run', 42, []]) {
      expect(isValidEvent(junk)).toBe(false);
    }
  });
});

describe('buckets', () => {
  it('buckets durations at the documented edges', () => {
    expect(durationBucket(0)).toBe('lt_100ms');
    expect(durationBucket(99)).toBe('lt_100ms');
    expect(durationBucket(100)).toBe('lt_500ms');
    expect(durationBucket(499)).toBe('lt_500ms');
    expect(durationBucket(500)).toBe('lt_2s');
    expect(durationBucket(1_999)).toBe('lt_2s');
    expect(durationBucket(2_000)).toBe('lt_10s');
    expect(durationBucket(9_999)).toBe('lt_10s');
    expect(durationBucket(10_000)).toBe('lt_60s');
    expect(durationBucket(59_999)).toBe('lt_60s');
    expect(durationBucket(60_000)).toBe('ge_60s');
  });

  it('is total — every input lands on a declared bucket, never on a raw reading', () => {
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e12]) {
      expect(DURATION_BUCKETS, String(ms)).toContain(durationBucket(ms));
    }
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e15]) {
      expect(UPTIME_BUCKETS, String(ms)).toContain(uptimeBucket(ms));
    }
  });

  it('buckets uptime at the documented edges', () => {
    const hour = 3_600_000;
    expect(uptimeBucket(0)).toBe('lt_1h');
    expect(uptimeBucket(hour - 1)).toBe('lt_1h');
    expect(uptimeBucket(hour)).toBe('lt_8h');
    expect(uptimeBucket(8 * hour)).toBe('lt_24h');
    expect(uptimeBucket(24 * hour)).toBe('lt_7d');
    expect(uptimeBucket(7 * 24 * hour)).toBe('ge_7d');
  });
});

describe('the dictionary is closed at the type level', () => {
  it('cannot construct an event with a free-text prop', () => {
    // ⚠ WHICH GATE CHECKS THESE, measured rather than assumed: `tsconfig.test.json`
    // (`npm run typecheck:studio`) is an explicit ALLOWLIST of studio safety-surface test
    // files and does not include this one, so it would not see these arms at all. They are
    // checked by `npm run typecheck:debt`, whose `tsconfig.tests-debt.json` does cover
    // tests/unit/telemetry/ and fails when the error count rises above its baseline. Both
    // run inside `gate:studio`. Verified by opening the dictionary and watching the count
    // go 363 -> 366 with three TS2578 'Unused @ts-expect-error directive' errors here.
    // Each `@ts-expect-error` is itself the assertion: if the dictionary ever stopped
    // rejecting the line below, the directive goes unused and the gate reds.

    // @ts-expect-error — `query` is not a prop of tool.run, and no event has a free-text prop.
    const withQuery: TelemetryEvent = { name: 'tool.run', props: { tool: 'search', surface: 'mcp', ok: true, duration_bucket: 'lt_2s', query: 'secret' } };

    // @ts-expect-error — `tool` is a closed enum, not a string.
    const openTool: TelemetryEvent = { name: 'tool.run', props: { tool: 'not_a_tool', surface: 'mcp', ok: true, duration_bucket: 'lt_2s' } };

    // @ts-expect-error — error classes carry no message.
    const withMessage: TelemetryEvent = { name: 'tool.error', props: { tool: 'fetch', surface: 'cli', error_class: 'timeout', message: 'ENOTFOUND api.internal' } };

    // @ts-expect-error — an unlisted event name is not in the union.
    const unlisted: TelemetryEvent = { name: 'page.scraped', props: {} };

    // The values are only here so the declarations are used; the assertion is the directive.
    expect([withQuery, openTool, withMessage, unlisted]).toHaveLength(4);
  });
});
