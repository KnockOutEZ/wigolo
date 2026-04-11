import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { resetConfig } from '../../src/config.js';

describe('logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    resetConfig();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('writes JSON lines to stderr in json format', () => {
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'debug';
    resetConfig();
    const log = createLogger('fetch');
    log.info('test message', { url: 'https://example.com' });

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.module).toBe('fetch');
    expect(parsed.data.url).toBe('https://example.com');
    expect(parsed.ts).toBeDefined();
  });

  it('respects log level filtering', () => {
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'warn';
    resetConfig();
    const log = createLogger('fetch');
    log.info('should not appear');
    log.debug('should not appear');
    log.warn('should appear');

    const warnCalls = stderrSpy.mock.calls.filter(call => {
      try { return JSON.parse(call[0] as string).level === 'warn'; } catch { return false; }
    });
    expect(warnCalls.length).toBe(1);
  });

  it('writes text format when configured', () => {
    process.env.LOG_FORMAT = 'text';
    process.env.LOG_LEVEL = 'debug';
    resetConfig();
    const log = createLogger('search');
    log.error('something broke', { code: 'ECONNREFUSED' });

    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('ERROR');
    expect(output).toContain('[search]');
    expect(output).toContain('something broke');
  });

  it('never writes to stdout', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.env.LOG_LEVEL = 'debug';
    resetConfig();
    const log = createLogger('fetch');
    log.info('test');
    log.warn('test');
    log.error('test');
    log.debug('test');
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});
