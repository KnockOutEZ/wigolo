import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('suppresses stderr output in TUI mode', () => {
    process.env.WIGOLO_TUI_MODE = 'true';
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'debug';
    resetConfig();
    const log = createLogger('fetch');
    log.info('should not appear on stderr');
    log.warn('this neither');

    expect(stderrSpy).not.toHaveBeenCalled();
    delete process.env.WIGOLO_TUI_MODE;
  });

  it('suppresses stderr in TUI mode for text format too', () => {
    process.env.WIGOLO_TUI_MODE = 'true';
    process.env.LOG_FORMAT = 'text';
    process.env.LOG_LEVEL = 'debug';
    resetConfig();
    const log = createLogger('search');
    log.error('should not appear');

    expect(stderrSpy).not.toHaveBeenCalled();
    delete process.env.WIGOLO_TUI_MODE;
  });

  /**
   * The `Module` union used to hardcode the product name, so core had to know a product existed for
   * `createLogger('<product>')` to typecheck. It is now open past core's own subsystem list.
   */
  describe('labels beyond core subsystems', () => {
    it('a surface core does not own logs under its own label', () => {
      process.env.LOG_FORMAT = 'json';
      process.env.LOG_LEVEL = 'debug';
      resetConfig();
      // Not a member of CoreModule. Before this change adding a label meant editing core's union.
      createLogger('atlas').info('from a surface core does not enumerate');

      const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      expect(parsed.module).toBe('atlas');
    });

    it('the existing studio label keeps working — this is a type change, not a behaviour change', () => {
      process.env.LOG_FORMAT = 'json';
      process.env.LOG_LEVEL = 'debug';
      resetConfig();
      createLogger('studio').warn('still labelled the same');

      const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      expect(parsed.module).toBe('studio');
    });

    it('core no longer enumerates the product name in its subsystem union', () => {
      const src = readFileSync(join(import.meta.dirname, '../../src/logger.ts'), 'utf8');
      const union = src.split('\n').find((l) => l.startsWith('type CoreModule'));
      expect(union, 'CoreModule union not found — did the type get renamed?').toBeDefined();
      expect(union).not.toContain("'studio'");
      // Still a real enumeration, not widened to bare `string` — the core labels must stay
      // autocompletable and typo-catchable.
      expect(union).toContain("'fetch'");
      expect(union).toContain("'cache'");
    });
  });
});
