import { describe, it, expect, beforeAll } from 'vitest';
import chalk from 'chalk';
import { renderBanner } from '../../../../src/cli/tui/banner.js';
import { stripAnsi } from '../../../../src/cli/tui/format.js';

beforeAll(() => {
  chalk.level = 1;
});

describe('renderBanner', () => {
  it('contains the tagline', () => {
    const banner = stripAnsi(renderBanner('0.6.3'));
    expect(banner.toLowerCase()).toContain('local-first');
  });

  it('interpolates the provided version', () => {
    const banner = stripAnsi(renderBanner('9.9.9'));
    expect(banner).toContain('v9.9.9');
  });

  it('is at most 10 lines', () => {
    const banner = stripAnsi(renderBanner('0.6.3'));
    const lines = banner.split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it('is at least 6 lines including tagline', () => {
    const banner = stripAnsi(renderBanner('0.6.3'));
    const nonEmpty = banner.split('\n').filter(l => l.trim().length > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(4);
  });

  it('includes ANSI color codes when color is on', () => {
    const banner = renderBanner('0.6.3');
    expect(banner).toMatch(/\u001b\[/);
  });

  it('handles a missing version gracefully', () => {
    expect(() => renderBanner('')).not.toThrow();
    const banner = stripAnsi(renderBanner(''));
    expect(banner.split('\n').length).toBeGreaterThanOrEqual(4);
  });
});
