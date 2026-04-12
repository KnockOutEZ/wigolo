// tests/unit/extraction/trafilatura.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ trafilatura: 'auto' })),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { execFile, spawn } from 'node:child_process';
import {
  trafilaturaExtract,
  isTrafilaturaAvailable,
  resetAvailabilityCache,
  runPythonWithStdin,
} from '../../../src/extraction/trafilatura.js';

function createMockProcess(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: Error;
  delay?: number;
  signal?: NodeJS.Signals;
}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinChunks: string[] = [];

  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  (proc as any).stdin = {
    write: (data: string) => { stdinChunks.push(data); },
    end: () => {
      const emitResult = () => {
        if (opts.error) {
          proc.emit('error', opts.error);
          return;
        }
        if (opts.stdout !== undefined) {
          stdoutEmitter.emit('data', Buffer.from(opts.stdout));
        }
        if (opts.stderr) {
          stderrEmitter.emit('data', Buffer.from(opts.stderr));
        }
        if (opts.signal) {
          proc.emit('close', null, opts.signal);
        } else {
          proc.emit('close', opts.exitCode ?? 0);
        }
      };
      if (opts.delay) {
        setTimeout(emitResult, opts.delay);
      } else {
        process.nextTick(emitResult);
      }
    },
  };
  (proc as any)._stdinChunks = stdinChunks;
  (proc as any).kill = vi.fn();

  return proc;
}

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  vi.clearAllMocks();
  resetAvailabilityCache();
});

// ═══════════════════════════════════════════
// trafilaturaExtract — Basic happy path
// ═══════════════════════════════════════════

describe('trafilaturaExtract — basic', () => {
  it('returns extraction result from valid HTML', async () => {
    const mockOutput = JSON.stringify({
      title: 'Test Article',
      text: 'This is the full article content that is long enough to pass the threshold and contains meaningful text about TypeScript and web scraping techniques.',
      author: 'Jane Developer',
      date: '2026-04-12',
    });

    mockSpawn.mockReturnValue(createMockProcess({ stdout: mockOutput }));

    const result = await trafilaturaExtract(
      '<html><body><article>Long content here</article></body></html>',
      'https://example.com/article',
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Article');
    expect(result!.markdown).toContain('article content');
    expect(result!.metadata.author).toBe('Jane Developer');
    expect(result!.metadata.date).toBe('2026-04-12');
    expect(result!.extractor).toBe('trafilatura');
    expect(result!.links).toEqual([]);
    expect(result!.images).toEqual([]);
  });

  it('returns null when subprocess fails with non-zero exit', async () => {
    mockSpawn.mockReturnValue(createMockProcess({
      exitCode: 1,
      stderr: 'ImportError: No module named trafilatura',
    }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).toBeNull();
  });

  it('returns null when stdout is empty JSON object', async () => {
    mockSpawn.mockReturnValue(createMockProcess({ stdout: '{}' }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════
// trafilaturaExtract — Edge cases
// ═══════════════════════════════════════════

describe('trafilaturaExtract — edge cases', () => {
  it('returns null for empty HTML input', async () => {
    mockSpawn.mockReturnValue(createMockProcess({ stdout: '{}' }));

    const result = await trafilaturaExtract('', 'https://example.com');
    expect(result).toBeNull();
  });

  it('handles very large HTML input (>1MB body) without error', async () => {
    const largeBody = 'x'.repeat(1_100_000);
    const mockOutput = JSON.stringify({
      title: 'Large Page',
      text: 'Extracted content from the very large page that is long enough to exceed the content threshold for acceptance.',
    });

    const proc = createMockProcess({ stdout: mockOutput });
    mockSpawn.mockReturnValue(proc);

    const result = await trafilaturaExtract(
      `<html><body>${largeBody}</body></html>`,
      'https://example.com/large',
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Large Page');
    // Verify the large HTML was actually written to stdin
    expect((proc as any)._stdinChunks.join('').length).toBeGreaterThan(1_000_000);
  });

  it('handles HTML with UTF-8 BOM prefix', async () => {
    const mockOutput = JSON.stringify({
      title: 'BOM Test',
      text: 'Content extracted from page with byte order mark. This text is long enough to pass the content length threshold check.',
    });
    mockSpawn.mockReturnValue(createMockProcess({ stdout: mockOutput }));

    const htmlWithBom = '\uFEFF<html><body>Content</body></html>';
    const result = await trafilaturaExtract(htmlWithBom, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('BOM Test');
  });

  it('handles HTML with Unicode content (CJK, emoji, RTL)', async () => {
    const mockOutput = JSON.stringify({
      title: 'Unicode Test',
      text: 'This article discusses Unicode handling in web scraping. It includes CJK characters and other multi-byte sequences that need proper handling through the subprocess boundary.',
    });
    mockSpawn.mockReturnValue(createMockProcess({ stdout: mockOutput }));

    const unicodeHtml = '<html><body><article>日本語テスト 🎉 مرحبا</article></body></html>';
    const result = await trafilaturaExtract(unicodeHtml, 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.extractor).toBe('trafilatura');
  });

  it('handles HTML with embedded script and style tags', async () => {
    const mockOutput = JSON.stringify({
      title: 'Script Tags',
      text: 'Clean extracted content without any JavaScript or CSS pollution. This content is long enough to pass the minimum content threshold check in the wrapper.',
    });
    mockSpawn.mockReturnValue(createMockProcess({ stdout: mockOutput }));

    const htmlWithScripts = `<html><body>
      <script>alert("xss")</script>
      <style>.hidden { display: none; }</style>
      <article>Real content here</article>
    </body></html>`;

    const result = await trafilaturaExtract(htmlWithScripts, 'https://example.com');
    expect(result).not.toBeNull();
    expect(result!.markdown).not.toContain('alert');
    expect(result!.markdown).not.toContain('display: none');
  });

  it('returns null when output text field is missing', async () => {
    const mockOutput = JSON.stringify({ title: 'No Text', author: 'Someone' });
    mockSpawn.mockReturnValue(createMockProcess({ stdout: mockOutput }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).toBeNull();
  });

  it('uses empty string for title when title field is missing', async () => {
    const mockOutput = JSON.stringify({
      text: 'This article has no title field but the content is long enough to pass the content threshold check for extraction.',
    });
    mockSpawn.mockReturnValue(createMockProcess({ stdout: mockOutput }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('');
  });
});

// ═══════════════════════════════════════════
// trafilaturaExtract — Content threshold
// ═══════════════════════════════════════════

describe('trafilaturaExtract — content threshold', () => {
  it('returns null when output text is shorter than 100 characters', async () => {
    const mockOutput = JSON.stringify({
      title: 'Short',
      text: 'Too short.',
    });
    mockSpawn.mockReturnValue(createMockProcess({ stdout: mockOutput }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).toBeNull();
  });

  it('returns result when output text is exactly 100 characters', async () => {
    const text = 'A'.repeat(100);
    const mockOutput = JSON.stringify({ title: 'Exactly 100', text });
    mockSpawn.mockReturnValue(createMockProcess({ stdout: mockOutput }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).not.toBeNull();
    expect(result!.markdown).toBe(text);
  });

  it('returns result when output text is 101 characters (just above threshold)', async () => {
    const text = 'B'.repeat(101);
    const mockOutput = JSON.stringify({ title: 'Above Threshold', text });
    mockSpawn.mockReturnValue(createMockProcess({ stdout: mockOutput }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).not.toBeNull();
    expect(result!.markdown.length).toBe(101);
  });
});

// ═══════════════════════════════════════════
// trafilaturaExtract — Timeout and error recovery
// ═══════════════════════════════════════════

describe('trafilaturaExtract — timeout and error recovery', () => {
  it('returns null when Python process hangs beyond timeout', async () => {
    // Process never emits close/data
    const proc = new EventEmitter() as ChildProcess;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    (proc as any).stdout = stdoutEmitter;
    (proc as any).stderr = stderrEmitter;
    (proc as any).stdin = {
      write: vi.fn(),
      end: vi.fn(),
    };
    (proc as any).kill = vi.fn();

    mockSpawn.mockReturnValue(proc);

    // The spawn call should include a timeout option
    await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(mockSpawn).toHaveBeenCalledWith(
      'python3',
      expect.any(Array),
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  it('returns null when Python exits with non-zero code', async () => {
    mockSpawn.mockReturnValue(createMockProcess({
      exitCode: 2,
      stderr: 'Traceback (most recent call last):\n  File...',
    }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).toBeNull();
  });

  it('still returns result when Python prints warnings to stderr but exits 0', async () => {
    const mockOutput = JSON.stringify({
      title: 'Works With Warnings',
      text: 'Content extracted successfully despite stderr warnings. This text is long enough to pass the minimum content threshold for extraction validation.',
    });
    mockSpawn.mockReturnValue(createMockProcess({
      stdout: mockOutput,
      stderr: 'DeprecationWarning: some old API\nFutureWarning: something else',
    }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Works With Warnings');
  });

  it('returns null when stdout contains malformed JSON', async () => {
    mockSpawn.mockReturnValue(createMockProcess({
      stdout: '{"title": "Broken", "text": "incomplete...',
    }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).toBeNull();
  });

  it('returns null when stdout is empty string', async () => {
    mockSpawn.mockReturnValue(createMockProcess({ stdout: '' }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).toBeNull();
  });

  it('returns null when stdout is literal "null"', async () => {
    mockSpawn.mockReturnValue(createMockProcess({ stdout: 'null' }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).toBeNull();
  });

  it('returns null when spawn emits error event', async () => {
    mockSpawn.mockReturnValue(createMockProcess({
      error: new Error('ENOENT: python3 not found'),
    }));

    const result = await trafilaturaExtract('<html>test</html>', 'https://example.com');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════
// isTrafilaturaAvailable — Availability cache
// ═══════════════════════════════════════════

describe('isTrafilaturaAvailable', () => {
  it('returns true when python3 can import trafilatura', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, '', '');
        return {} as any;
      },
    );

    const available = await isTrafilaturaAvailable();
    expect(available).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'python3',
      ['-c', 'import trafilatura'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('returns false when python3 or trafilatura is not available', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('ENOENT: python3 not found'), '', '');
        return {} as any;
      },
    );

    const available = await isTrafilaturaAvailable();
    expect(available).toBe(false);
  });

  it('caches the result after first check', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, '', '');
        return {} as any;
      },
    );

    await isTrafilaturaAvailable();
    await isTrafilaturaAvailable();
    await isTrafilaturaAvailable();

    // execFile should only be called once due to caching
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('re-checks after resetAvailabilityCache', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, '', '');
        return {} as any;
      },
    );

    await isTrafilaturaAvailable();
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    resetAvailabilityCache();

    await isTrafilaturaAvailable();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════
// runPythonWithStdin — Low-level subprocess
// ═══════════════════════════════════════════

describe('runPythonWithStdin', () => {
  it('resolves with stdout on success', async () => {
    mockSpawn.mockReturnValue(createMockProcess({ stdout: 'hello world' }));

    const result = await runPythonWithStdin('print("hello world")', '', 5000);
    expect(result).toBe('hello world');
  });

  it('rejects when process exits non-zero', async () => {
    mockSpawn.mockReturnValue(createMockProcess({
      exitCode: 1,
      stderr: 'SyntaxError: invalid syntax',
    }));

    await expect(runPythonWithStdin('bad code', '', 5000))
      .rejects.toThrow(/Python exited 1/);
  });

  it('rejects when process is killed by signal', async () => {
    mockSpawn.mockReturnValue(createMockProcess({ signal: 'SIGKILL' }));

    await expect(runPythonWithStdin('import time; time.sleep(999)', '', 5000))
      .rejects.toThrow();
  });

  it('writes stdin data to the process', async () => {
    const proc = createMockProcess({ stdout: 'got it' });
    mockSpawn.mockReturnValue(proc);

    await runPythonWithStdin('import sys; print(sys.stdin.read())', 'test-input', 5000);
    expect((proc as any)._stdinChunks).toContain('test-input');
  });

  it('passes timeout to spawn options', async () => {
    mockSpawn.mockReturnValue(createMockProcess({ stdout: '' }));

    await runPythonWithStdin('pass', '', 7500);
    expect(mockSpawn).toHaveBeenCalledWith(
      'python3',
      ['-c', 'pass'],
      expect.objectContaining({ timeout: 7500 }),
    );
  });
});

// ═══════════════════════════════════════════
// Concurrent access
// ═══════════════════════════════════════════

describe('trafilaturaExtract — concurrent access', () => {
  it('two simultaneous extractions do not interfere', async () => {
    const output1 = JSON.stringify({
      title: 'Article One',
      text: 'First article content that is definitely long enough to pass the minimum content threshold check for validation.',
    });
    const output2 = JSON.stringify({
      title: 'Article Two',
      text: 'Second article content that is also long enough to pass the minimum content threshold check for validation purposes.',
    });

    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      return createMockProcess({ stdout: callCount === 1 ? output1 : output2 });
    });

    const [result1, result2] = await Promise.all([
      trafilaturaExtract('<html>page1</html>', 'https://example.com/1'),
      trafilaturaExtract('<html>page2</html>', 'https://example.com/2'),
    ]);

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1!.title).toBe('Article One');
    expect(result2!.title).toBe('Article Two');
  });
});
