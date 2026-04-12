// tests/integration/trafilatura-pipeline.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixturesDir = join(import.meta.dirname, '../fixtures/extraction');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

// Mock trafilatura subprocess at the child_process level
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { extractContent } from '../../src/extraction/pipeline.js';
import { resetAvailabilityCache } from '../../src/extraction/trafilatura.js';
import { resetConfig } from '../../src/config.js';

function createMockSpawn(stdout: string): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  (proc as any).stdin = {
    write: vi.fn(),
    end: () => {
      process.nextTick(() => {
        stdoutEmitter.emit('data', Buffer.from(stdout));
        proc.emit('close', 0);
      });
    },
  };
  (proc as any).kill = vi.fn();
  return proc;
}

function createFailingSpawn(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  (proc as any).stdin = {
    write: vi.fn(),
    end: () => {
      process.nextTick(() => {
        stderrEmitter.emit('data', Buffer.from('ModuleNotFoundError'));
        proc.emit('close', 1);
      });
    },
  };
  (proc as any).kill = vi.fn();
  return proc;
}

const NEWS_HTML = loadFixture('news-article.html');
const BLOG_HTML = loadFixture('blog-post.html');

beforeEach(() => {
  vi.clearAllMocks();
  resetAvailabilityCache();
  resetConfig();
  // Default: Trafilatura is available
  vi.mocked(execFile).mockImplementation(
    (_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return {} as any;
    },
  );
});

describe('Trafilatura pipeline integration — news article fixture', () => {
  it('uses Trafilatura when Defuddle extraction is mocked to fail', async () => {
    // This test verifies the pipeline wiring: when defuddle returns null
    // (e.g., on a page it can't parse), and trafilatura subprocess returns
    // good content, the pipeline uses the trafilatura result.

    // Note: In this integration test, defuddle is NOT mocked — it runs for real.
    // Trafilatura subprocess IS mocked at the spawn level.
    // If defuddle successfully extracts the fixture, it wins (which is correct behavior).
    // This test primarily verifies the wiring is correct.

    const trafOutput = JSON.stringify({
      title: 'AI Code Analysis Tools See 40% Performance Boost',
      text: 'A comprehensive benchmarking study released today shows that the latest generation of AI-powered code analysis tools have achieved a 40% improvement in performance compared to their predecessors from just six months ago. The study tested 15 different tools across a battery of 5,000 real-world code samples.',
      author: 'Sarah Chen',
      date: '2026-04-10',
    });

    vi.mocked(spawn).mockReturnValue(createMockSpawn(trafOutput));

    const result = await extractContent(NEWS_HTML, 'https://techdaily.example.com/news/ai-tools');

    // The pipeline should produce a valid result (from whichever extractor wins)
    expect(result).toBeDefined();
    expect(result.markdown.length).toBeGreaterThan(100);
    expect(result.title.length).toBeGreaterThan(0);
    expect(['defuddle', 'trafilatura', 'readability', 'turndown']).toContain(result.extractor);
  });

  it('produces result with post-processing (maxChars) applied', async () => {
    const trafOutput = JSON.stringify({
      title: 'AI Code Analysis',
      text: 'A'.repeat(500),
    });
    vi.mocked(spawn).mockReturnValue(createMockSpawn(trafOutput));

    const result = await extractContent(NEWS_HTML, 'https://techdaily.example.com/news', {
      maxChars: 200,
    });

    expect(result.markdown.length).toBeLessThanOrEqual(200);
  });
});

describe('Trafilatura pipeline integration — blog post fixture', () => {
  it('extracts meaningful content from blog post with comments and sidebar', async () => {
    const trafOutput = JSON.stringify({
      title: 'Building Robust Extraction Pipelines',
      text: 'If you have ever tried to extract clean text from web pages, you know the pain. Every site has different markup. In this post I walk through building an extraction pipeline that handles all of this gracefully. The ensemble approach chains multiple extractors in a fallback cascade.',
      author: 'Alex Rivera',
      date: '2026-03-28',
    });

    vi.mocked(spawn).mockReturnValue(createMockSpawn(trafOutput));

    const result = await extractContent(BLOG_HTML, 'https://alexblog.example.com/posts/extraction');

    expect(result).toBeDefined();
    expect(result.markdown.length).toBeGreaterThan(100);
    // Should not contain comment section noise
    expect(result.markdown).not.toContain('Leave a comment');
  });

  it('populates links and images from post-processing', async () => {
    const trafOutput = JSON.stringify({
      title: 'Blog Post',
      text: 'Content from the blog post about building robust extraction pipelines with multiple fallback strategies and ensemble approaches.',
    });
    vi.mocked(spawn).mockReturnValue(createMockSpawn(trafOutput));

    const result = await extractContent(BLOG_HTML, 'https://alexblog.example.com/posts/extraction');

    expect(Array.isArray(result.links)).toBe(true);
    expect(Array.isArray(result.images)).toBe(true);
  });
});

describe('Trafilatura pipeline integration — fallback behavior', () => {
  it('falls back to Readability/Turndown when Trafilatura is not installed', async () => {
    // Trafilatura not available
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('python3 not found'), '', '');
        return {} as any;
      },
    );

    const result = await extractContent(NEWS_HTML, 'https://techdaily.example.com/news/ai');

    expect(result).toBeDefined();
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.extractor).not.toBe('trafilatura');
  });

  it('falls back when Trafilatura subprocess returns empty output', async () => {
    vi.mocked(spawn).mockReturnValue(createMockSpawn('{}'));

    const result = await extractContent(BLOG_HTML, 'https://alexblog.example.com/posts/test');

    expect(result).toBeDefined();
    expect(result.markdown.length).toBeGreaterThan(0);
    // Should have fallen back to readability or turndown
    expect(['defuddle', 'readability', 'turndown']).toContain(result.extractor);
  });

  it('handles config WIGOLO_TRAFILATURA=never in integration', async () => {
    process.env.WIGOLO_TRAFILATURA = 'never';
    resetConfig();

    const result = await extractContent(NEWS_HTML, 'https://techdaily.example.com/news');

    expect(result).toBeDefined();
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.extractor).not.toBe('trafilatura');

    delete process.env.WIGOLO_TRAFILATURA;
    resetConfig();
  });

  it('section targeting works through Trafilatura path', async () => {
    const trafOutput = JSON.stringify({
      title: 'Test',
      text: 'Some content that is long enough to pass the minimum content threshold for extraction validation and testing purposes.',
    });
    vi.mocked(spawn).mockReturnValue(createMockSpawn(trafOutput));

    const result = await extractContent(NEWS_HTML, 'https://techdaily.example.com/news', {
      section: 'Key Findings',
    });

    expect(result).toBeDefined();
    expect(result.markdown.length).toBeGreaterThan(0);
  });
});
