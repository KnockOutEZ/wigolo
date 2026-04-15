import { describe, it, expect } from 'vitest';
import { getPackageVersion } from '../../../../src/cli/tui/version.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('getPackageVersion', () => {
  it('returns the version from package.json', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
    expect(getPackageVersion()).toBe(pkg.version);
  });

  it('returns a semver-shaped string', () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it('never throws', () => {
    expect(() => getPackageVersion()).not.toThrow();
  });
});
