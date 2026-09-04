import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAccountCommand } from '../../../src/cli/account.js';
import { ACTIVATION_REFUSALS, type ActivationRefusalReason } from '../../../src/account/gate.js';
import { activationNextStepLine } from '../../../src/cli/init.js';
import { advancedCategory } from '../../../src/cli/tui/schema/advanced.js';
import { runStudioSetup } from '../../../src/cli/studio-setup.js';
import type { AccountsClient } from '../../../src/account/client.js';

/**
 * The capability register, applied to the copy PX2 added.
 *
 * WHY THIS FILE EXISTS: `sanitizeCapabilityText` (`src/cli/help.ts`) is a render-time
 * guard on schema-derived FLAG DESCRIPTIONS and nothing else. Every string this phase
 * introduced — the five account verbs' output, the three refusal lines, doctor's account
 * and telemetry lines, init's next step — is written directly to a stream and passes
 * through no sanitizer at all. The mini-spec (§8) accepted that gap and assigned the
 * review to a human. A human review is a fact about one afternoon; this is the same
 * review expressed as a property, so the next string added to these surfaces inherits it.
 *
 * The corpus is collected by RUNNING the surfaces rather than by scanning source text:
 * a scan cannot tell a comment from a string, and it cannot see a line that only exists
 * after interpolation.
 */
const BANNED: ReadonlyArray<[RegExp, string]> = [
  [/playwright/i, 'browser engine'],
  [/puppeteer/i, 'browser engine'],
  [/\bchromium\b/i, 'browser engine'],
  [/\belectron\b/i, 'browser engine'],
  [/\bcdp\b/i, 'browser control protocol'],
  [/\bsearxng\b/i, 'search engine'],
  [/flaresolverr/i, 'challenge solver'],
  [/readability/i, 'content extractor'],
  [/defuddle/i, 'content extractor'],
  [/trafilatura/i, 'content extractor'],
  [/turndown/i, 'markdown converter'],
  [/flashrank/i, 'ML reranker'],
  [/\bonnx\b/i, 'ML runtime'],
  [/xenova|minilm|bge-/i, 'ML model name'],
  [/posthog|mixpanel|amplitude|segment\.io|\bsentry\b/i, 'analytics vendor'],
  [/keytar|napi|better-sqlite|fastify|tldts/i, 'library name'],
  [/ed25519|\bjose\b/i, 'crypto implementation'],
];

function assertCapabilityLanguage(label: string, text: string): void {
  for (const [pattern, capability] of BANNED) {
    expect(
      pattern.test(text),
      `${label} names an implementation where the capability register wants "${capability}": ${text}`,
    ).toBe(false);
  }
}

/** Collects everything a verb writes, both streams, as one string. */
function collector(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/**
 * A client whose every call fails the way an unreachable service does. That is the arm
 * that produces the MOST copy: each verb has a distinct failure line, and those lines are
 * exactly the ones a hand review is likeliest to skip.
 */
function unreachableClient(): AccountsClient {
  const fail = async (): Promise<unknown> => ({ ok: false, code: 'network', message: 'connect ECONNREFUSED' });
  return {
    requestCode: fail,
    verify: fail,
    refresh: fail,
    entitlementsToken: fail,
    entitlementsKeys: fail,
    account: fail,
    accountExport: fail,
    deleteAccount: fail,
    telemetryDisclosure: fail,
    telemetryBatch: fail,
  } as unknown as AccountsClient;
}

async function runVerb(
  verb: Parameters<typeof runAccountCommand>[0],
  args: readonly string[],
  stdin: string,
): Promise<string> {
  const err = collector();
  const out = collector();
  const dataDir = mkdtempSync(join(tmpdir(), 'wigolo-caplang-'));
  await runAccountCommand(verb, args, {
    dataDir,
    client: unreachableClient(),
    env: {},
    nowMs: () => Date.parse('2026-09-02T00:00:00Z'),
    input: Readable.from([stdin]),
    stderr: err.stream,
    stdout: out.stream,
  });
  return `${err.text()}${out.text()}`;
}

describe('capability language — the copy PX2 added', () => {
  it('the three activation refusals name no implementation', () => {
    // These are the most-read strings in the phase: every gated surface prints one.
    for (const [reason, line] of Object.entries(ACTIVATION_REFUSALS)) {
      assertCapabilityLanguage(`refusal ${reason}`, line);
    }
    // Not vacuous: the corpus is the real, non-empty register.
    expect(Object.keys(ACTIVATION_REFUSALS)).toHaveLength(3);
    expect(ACTIVATION_REFUSALS.never_activated).toContain('wigolo register');
  });

  it("init's next step names no implementation, for every reason it can fire on", async () => {
    const actual = await vi.importActual<typeof import('../../../src/account/gate.js')>(
      '../../../src/account/gate.js',
    );
    const reasons: ActivationRefusalReason[] = ['never_activated', 'expired', 'update_required'];
    const seen: string[] = [];
    for (const reason of reasons) {
      vi.doMock('../../../src/account/gate.js', () => ({
        ...actual,
        evaluateActivation: () => ({ ok: false, step: 'no_token', reason, message: '' }),
      }));
      vi.resetModules();
      const { activationNextStepLine: fresh } = await import('../../../src/cli/init.js');
      const line = await fresh(mkdtempSync(join(tmpdir(), 'wigolo-caplang-init-')), {}, Date.now());
      expect(line, `no line for ${reason}`).not.toBeNull();
      assertCapabilityLanguage(`init next step (${reason})`, line as string);
      seen.push(line as string);
      vi.doUnmock('../../../src/account/gate.js');
      vi.resetModules();
    }
    // Three reasons, three DIFFERENT lines — a single shared line would make the sweep
    // above cover one string while claiming three.
    expect(new Set(seen).size).toBe(3);
    // And the real export still works unmocked.
    expect(typeof activationNextStepLine).toBe('function');
  });

  it.each([
    ['whoami', [] as readonly string[], ''],
    ['logout', [] as readonly string[], ''],
    ['register', [] as readonly string[], 'someone@example.com\n'],
    ['login', [] as readonly string[], 'someone@example.com\n'],
    // Two rejection lines that only a BAD input reaches. Driving these verbs with a
    // valid address walks straight past them, which is how a review misses copy.
    ['register', [] as readonly string[], 'not-an-address\n'],
    ['login', [] as readonly string[], '\n'],
    ['account', [] as readonly string[], ''],
    ['account', ['export', '/dev/null'] as readonly string[], ''],
    ['account', ['delete'] as readonly string[], 'no\n'],
    ['account', ['frobnicate'] as readonly string[], ''],
  ])('`wigolo %s %s` writes only capability language', async (verb, args, stdin) => {
    const text = await runVerb(verb as Parameters<typeof runAccountCommand>[0], args, stdin);
    // Every one of these arms must actually SAY something, or the assertion below is
    // a check on the empty string.
    expect(text.trim().length, `\`${verb} ${args.join(' ')}\` wrote nothing`).toBeGreaterThan(0);
    assertCapabilityLanguage(`wigolo ${verb} ${args.join(' ')}`, text);
  });

  it('the account service address notice names no implementation, escalated or not', async () => {
    // Copy that only exists when an override is in force, so every arm above
    // walks straight past it — which is how the corpus loses a string.
    for (const url of ['https://accounts.example.test', 'http://accounts.example.test']) {
      for (const env of [{}, { WIGOLO_ACCOUNTS_URL: url }]) {
        const err = collector();
        await runAccountCommand('whoami', [], {
          dataDir: mkdtempSync(join(tmpdir(), 'wigolo-caplang-url-')),
          accountsUrl: url,
          client: unreachableClient(),
          env,
          nowMs: () => Date.parse('2026-09-02T00:00:00Z'),
          input: Readable.from(['']),
          stderr: err.stream,
          stdout: collector().stream,
        });
        const text = err.text();
        expect(text, `no notice for ${url}`).toContain('account service address');
        assertCapabilityLanguage(`address notice ${url}`, text);
      }
    }
  });

  /**
   * The companion install verb, run for every outcome it can produce.
   *
   * This is the surface most at risk of slipping the register: it talks about a desktop
   * application, a disk image and a first run, and the honest engineering words for those are
   * exactly the banned ones. Every arm is exercised, including the failures — a failure line is
   * the one a hand review skips and the one a user reads most carefully.
   */
  it('`wigolo studio setup` names no implementation on any outcome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wigolo-capability-'));
    const arms: Array<[string, string[], Record<string, unknown>]> = [
      ['usage', [], {}],
      ['help', ['--help'], {}],
      ['unknown subcommand', ['observe'], {}],
      ['unknown option', ['setup', '--wat'], {}],
      ['unsupported platform', ['setup'], { platform: 'linux', arch: 'x64' }],
      ['no release host', ['setup'], { platform: 'darwin', arch: 'arm64', releaseHost: null }],
      [
        'unreachable host',
        ['setup'],
        {
          platform: 'darwin',
          arch: 'arm64',
          releaseHost: 'http://127.0.0.1:1',
          // The opt-out keeps this arm about an unreachable host. Without it the verb refuses the
          // cleartext address first and this arm would quietly stop exercising the transport error.
          env: { WIGOLO_COMPANION_ALLOW_HTTP: '1' },
        },
      ],
      [
        'insecure release host',
        ['setup'],
        { platform: 'darwin', arch: 'arm64', releaseHost: 'http://releases.example.com' },
      ],
    ];

    for (const [label, argv, deps] of arms) {
      const out = collector();
      const err = collector();
      await runStudioSetup(argv, {
        stdout: out.stream,
        stderr: err.stream,
        dataDir: join(root, label.replace(/\s+/g, '-')),
        installRoot: join(root, 'Applications'),
        ...deps,
      });
      const text = out.text() + err.text();
      expect(text, `${label} produced no copy at all`).not.toBe('');
      assertCapabilityLanguage(`studio setup / ${label}`, text);
    }
  });

  it('the two account/telemetry settings fields name no implementation', () => {
    const fields = advancedCategory.fields.filter(
      (f) => f.key === 'WIGOLO_ACCOUNTS_URL' || f.key === 'WIGOLO_TELEMETRY',
    );
    expect(fields).toHaveLength(2);
    for (const field of fields) {
      assertCapabilityLanguage(`${field.key} label`, field.label);
      assertCapabilityLanguage(`${field.key} help`, field.help ?? '');
    }
  });
});
