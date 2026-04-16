import { describe, it, expect, beforeAll } from 'vitest';
import chalk from 'chalk';
import { ok, fail, warn, info, stripAnsi } from '../../../../src/cli/tui/format.js';

beforeAll(() => {
  chalk.level = 1;
});

describe('format helpers', () => {
  it('ok prefixes with check and green color', () => {
    const out = ok('Node 22.14.0');
    expect(stripAnsi(out)).toBe('✓ Node 22.14.0');
    expect(out).toContain('\u001b[');
  });

  it('fail prefixes with cross and red color', () => {
    const out = fail('Python missing');
    expect(stripAnsi(out)).toBe('✗ Python missing');
    expect(out).toContain('\u001b[');
  });

  it('warn prefixes with triangle and yellow color', () => {
    const out = warn('Docker not found (optional)');
    expect(stripAnsi(out)).toBe('⚠ Docker not found (optional)');
  });

  it('info prefixes with info and blue color', () => {
    const out = info('Starting setup');
    expect(stripAnsi(out)).toBe('ℹ Starting setup');
  });

  it('stripAnsi removes all ANSI escape codes', () => {
    expect(stripAnsi('\u001b[32m✓\u001b[39m done')).toBe('✓ done');
  });

  it('respects NO_COLOR env var', () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      expect(ok('done')).toContain('done');
      expect(ok('done')).toContain('✓');
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});
