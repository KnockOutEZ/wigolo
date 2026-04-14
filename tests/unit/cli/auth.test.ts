import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  listSessions: vi.fn(),
  getAuthOptions: vi.fn(),
}));

vi.mock('../../../src/fetch/cdp-client.js', () => ({
  isCDPReachable: vi.fn(),
  discoverSessions: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { runAuth } from '../../../src/cli/auth.js';
import { listSessions, getAuthOptions } from '../../../src/fetch/auth.js';
import { isCDPReachable } from '../../../src/fetch/cdp-client.js';

describe('runAuth', () => {
  const originalEnv = process.env;
  let stderrOutput: string[];

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
    stderrOutput = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  describe('discover subcommand', () => {
    it('outputs session list when sessions are found', async () => {
      process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
      resetConfig();

      vi.mocked(listSessions).mockResolvedValue([
        { id: 'ABC', url: 'https://google.com', title: 'Google', webSocketDebuggerUrl: 'ws://localhost:9222/ABC' },
        { id: 'DEF', url: 'https://github.com', title: 'GitHub', webSocketDebuggerUrl: 'ws://localhost:9222/DEF' },
      ]);

      const code = await runAuth(['discover']);

      const output = stderrOutput.join('');
      expect(output).toContain('Google');
      expect(output).toContain('GitHub');
      expect(output).toContain('https://google.com');
      expect(output).toContain('https://github.com');
      expect(output).toContain('ABC');
      expect(code).toBe(0);
    });

    it('outputs no-sessions message when CDP returns empty', async () => {
      process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
      resetConfig();

      vi.mocked(listSessions).mockResolvedValue([]);

      const code = await runAuth(['discover']);

      const output = stderrOutput.join('');
      expect(output).toMatch(/no.*sessions|no.*found|empty/i);
      expect(code).toBe(0);
    });

    it('outputs error when CDP URL is not configured', async () => {
      delete process.env.WIGOLO_CDP_URL;
      resetConfig();

      const code = await runAuth(['discover']);

      const output = stderrOutput.join('');
      expect(output).toMatch(/WIGOLO_CDP_URL|not configured|no CDP/i);
      expect(code).toBe(1);
    });

    it('handles listSessions error gracefully', async () => {
      process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
      resetConfig();

      vi.mocked(listSessions).mockRejectedValue(new Error('Connection refused'));

      const code = await runAuth(['discover']);

      const output = stderrOutput.join('');
      expect(output).toMatch(/error|failed/i);
      expect(code).toBe(1);
    });

    it('outputs session IDs for programmatic use', async () => {
      process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
      resetConfig();

      vi.mocked(listSessions).mockResolvedValue([
        { id: 'X1', url: 'https://a.com', title: 'A', webSocketDebuggerUrl: 'ws://x/X1' },
      ]);

      const code = await runAuth(['discover']);

      const output = stderrOutput.join('');
      expect(output).toContain('X1');
      expect(code).toBe(0);
    });

    it('handles unicode in session titles', async () => {
      process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
      resetConfig();

      vi.mocked(listSessions).mockResolvedValue([
        { id: '1', url: 'https://a.com', title: 'Uber uns - Willkommen', webSocketDebuggerUrl: 'ws://x/1' },
      ]);

      const code = await runAuth(['discover']);

      const output = stderrOutput.join('');
      expect(output).toContain('Uber uns');
      expect(code).toBe(0);
    });
  });

  describe('status subcommand', () => {
    it('outputs auth configuration status', async () => {
      delete process.env.WIGOLO_AUTH_STATE_PATH;
      delete process.env.WIGOLO_CHROME_PROFILE_PATH;
      delete process.env.WIGOLO_CDP_URL;
      resetConfig();

      const code = await runAuth(['status']);

      const output = stderrOutput.join('');
      expect(output).toMatch(/storage state|chrome profile|cdp/i);
      expect(code).toBe(0);
    });

    it('shows configured storage state path', async () => {
      process.env.WIGOLO_AUTH_STATE_PATH = '/tmp/state.json';
      resetConfig();

      const code = await runAuth(['status']);

      const output = stderrOutput.join('');
      expect(output).toContain('/tmp/state.json');
      expect(code).toBe(0);
    });

    it('shows configured CDP URL', async () => {
      process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
      resetConfig();

      const code = await runAuth(['status']);

      const output = stderrOutput.join('');
      expect(output).toContain('http://localhost:9222');
      expect(code).toBe(0);
    });

    it('shows configured Chrome profile path', async () => {
      process.env.WIGOLO_CHROME_PROFILE_PATH = '/home/user/.config/google-chrome/Default';
      resetConfig();

      const code = await runAuth(['status']);

      const output = stderrOutput.join('');
      expect(output).toContain('/home/user/.config/google-chrome/Default');
      expect(code).toBe(0);
    });

    it('shows "not configured" for unconfigured methods', async () => {
      delete process.env.WIGOLO_AUTH_STATE_PATH;
      delete process.env.WIGOLO_CHROME_PROFILE_PATH;
      delete process.env.WIGOLO_CDP_URL;
      resetConfig();

      const code = await runAuth(['status']);

      const output = stderrOutput.join('');
      expect(output).toMatch(/not configured/i);
      expect(code).toBe(0);
    });
  });

  describe('unknown subcommand', () => {
    it('outputs usage help for unknown subcommand', async () => {
      const code = await runAuth(['unknown']);

      const output = stderrOutput.join('');
      expect(output).toMatch(/usage|unknown.*command|discover|status/i);
      expect(code).toBe(1);
    });

    it('outputs usage help for no subcommand', async () => {
      const code = await runAuth([]);

      const output = stderrOutput.join('');
      expect(output).toMatch(/usage|discover|status/i);
      expect(code).toBe(1);
    });
  });
});
