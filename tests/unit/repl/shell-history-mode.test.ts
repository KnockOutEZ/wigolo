import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable, Readable } from 'node:stream';

/**
 * LOW-2 (TOCTOU): the history file must be CREATED owner-only (mode 0o600) on
 * the first write — not created under the process umask and tightened by a
 * follow-up chmod. A loose umask (e.g. 0o000) makes the create-then-chmod
 * sequence leave a brief world/group-readable window; the final-mode assertion
 * in shell.test.ts cannot see it because chmod fixes the mode after the fact.
 * Here we mock node:fs and assert the create call itself carries { mode: 0o600 }
 * and that no post-create chmod is used to close a widened window.
 */

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 3),
  writeSync: vi.fn(),
  closeSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock('node:fs', () => fsMock);

// This file replaces node:fs WHOLESALE, so the activation gate at the top of
// `startShell` cannot read the account state the suite seeds on the real disk
// (tests/setup.ts): it would refuse before readline ever attaches and take every
// history-mode assertion below with it. The gate is not what this file is about,
// and its own arms — driven against a real un-activated data dir with a real
// signed token — live in tests/unit/server/activation-gate.test.ts and
// tests/integration/activation-cli.test.ts.
vi.mock('../../../src/server/activation.js', () => ({
  checkActivation: () => ({
    ok: true as const,
    step: 'perpetual' as const,
    payload: {
      account_id: 'acct_history_mode',
      issued_at: '2026-01-01T00:00:00.000Z',
      valid_until: '2099-01-01T00:00:00.000Z',
      grants: [
        { product: 'core', type: 'perpetual', features: null, expires: null, version_ceiling: null },
      ],
    },
  }),
}));

vi.mock('../../../src/repl/commands/fetch.js', () => ({ executeFetch: vi.fn() }));
vi.mock('../../../src/repl/commands/search.js', () => ({ executeSearch: vi.fn() }));
vi.mock('../../../src/repl/commands/cache.js', () => ({
  executeCache: vi.fn(async () => ({ stats: { total_urls: 0, total_size_mb: 0, oldest: '', newest: '' } })),
}));
vi.mock('../../../src/repl/commands/crawl.js', () => ({ executeCrawl: vi.fn() }));
vi.mock('../../../src/repl/commands/extract.js', () => ({ executeExtract: vi.fn() }));
vi.mock('../../../src/repl/commands/find-similar.js', () => ({ executeFindSimilar: vi.fn() }));
vi.mock('../../../src/repl/commands/research.js', () => ({ executeResearch: vi.fn() }));
vi.mock('../../../src/repl/commands/agent.js', () => ({ executeAgent: vi.fn() }));
vi.mock('../../../src/repl/commands/diff.js', () => ({ executeDiff: vi.fn() }));
vi.mock('../../../src/repl/commands/watch.js', () => ({ executeWatch: vi.fn() }));

import { startShell } from '../../../src/repl/shell.js';
import { resetConfig } from '../../../src/config.js';
import type { ReplDeps } from '../../../src/repl/commands/types.js';

const fakeDeps = {} as ReplDeps;

function scriptedInput(lines: string[]): NodeJS.ReadableStream {
  return Readable.from([`${lines.join('\n')}\n`]);
}

function sink(): NodeJS.WritableStream {
  return new Writable({ write(_c, _e, cb) { cb(); } });
}

describe('startShell — history file created owner-only (LOW-2 TOCTOU)', () => {
  beforeEach(() => {
    process.env.WIGOLO_SHELL_HISTORY_PATH = '/tmp/wigolo-hist-mode-test/history';
    resetConfig();
    vi.clearAllMocks();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockReturnValue('');
  });
  afterEach(() => {
    delete process.env.WIGOLO_SHELL_HISTORY_PATH;
    resetConfig();
  });

  it('creates the history file with mode 0o600 on the first write — no widen-after-create window', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits only
    await startShell(fakeDeps, {
      jsonMode: false,
      input: scriptedInput(['cache stats', 'exit']),
      output: sink(),
      errorOutput: sink(),
      isTty: true,
    });

    // The first write must carry the mode so the file is never created under a
    // loose umask. Accept either the appendFileSync options form or an
    // openSync('a', 0o600) form.
    const usedAppendMode = fsMock.appendFileSync.mock.calls.some(
      (call) => typeof call[2] === 'object' && (call[2] as { mode?: number }).mode === 0o600,
    );
    const usedOpenMode = fsMock.openSync.mock.calls.some((call) => call[2] === 0o600);
    expect(usedAppendMode || usedOpenMode).toBe(true);

    // And the fix must NOT depend on a post-create chmod to close the window.
    expect(fsMock.chmodSync).not.toHaveBeenCalled();
  });
});
