import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COMPANION_CONTRACT_VERSION,
  evaluateHandshake,
} from '../../../src/companion-contract/index.js';
import {
  CONTRACT_VERSIONS,
  HANDSHAKE_CASES,
  PINNED_CONTRACT_VERSION,
  SCHEMA_HEADS,
} from '../../../src/companion-contract/fixtures.js';

/**
 * The arms below are NOT written here. They come from the published fixture set
 * (`wigolo/companion-contract/fixtures`), which the app's own contract tests import from the same
 * tarball — that shared set is the mechanism, and a locally-typed hello would put this file back to
 * proving only that core agrees with itself. What stays local is the CALL and the assertion; what is
 * pinned centrally is every input and every §6 verdict.
 */
describe('companion handshake', () => {
  it.each(HANDSHAKE_CASES)('$id — $rule', ({ external, app, expected }) => {
    expect(evaluateHandshake(external, app)).toEqual(expected);
  });

  it('covers both directions of every §6 rule, so a dropped arm is visible', () => {
    expect(HANDSHAKE_CASES.map((c) => c.id)).toEqual([
      'major-mismatch-external-ahead',
      'major-mismatch-app-ahead',
      'minor-skew-external-ahead',
      'minor-skew-app-ahead',
      'schema-below-app-minimum',
      'schema-exactly-app-minimum',
      'schema-ahead-of-app-major-matches',
      'schema-ahead-of-app-major-differs',
    ]);
  });

  it('keeps the fixture skew constants ordered the way §6 reads them', () => {
    // The arms are only meaningful if the four heads sit in this order; an edit that reshuffles them
    // would leave every arm above still green while testing nothing §6 says.
    expect(SCHEMA_HEADS.belowAppMinimum).toBeLessThan(SCHEMA_HEADS.appMinimum);
    expect(SCHEMA_HEADS.appMinimum).toBeLessThan(SCHEMA_HEADS.current);
    expect(SCHEMA_HEADS.current).toBeLessThan(SCHEMA_HEADS.aheadOfApp);
    expect(CONTRACT_VERSIONS.major2.split('.')[0]).not.toBe(
      CONTRACT_VERSIONS.major1Low.split('.')[0],
    );
  });

  it('exports the pinned semver contract version, and the fixture set states the same pin', () => {
    expect(COMPANION_CONTRACT_VERSION).toBe('1.0.0');
    expect(COMPANION_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // The app pins the version core speaks from the fixture set, not from the runtime barrel. A bump
    // that moves one and not the other reds here rather than at a real pairing.
    expect(PINNED_CONTRACT_VERSION).toBe(COMPANION_CONTRACT_VERSION);
  });
});

describe('companion contract boundary', () => {
  it('contains only local imports', () => {
    const directory = join(process.cwd(), 'src', 'companion-contract');
    const files = readdirSync(directory).filter((file) => file.endsWith('.ts'));

    expect(files).toEqual(expect.arrayContaining(['handshake.ts', 'index.ts']));

    for (const file of files) {
      const source = readFileSync(join(directory, file), 'utf8');
      const specifiers = [
        ...source.matchAll(
          /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
        ),
        ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        expect(specifier, file).toBeDefined();
        expect(
          specifier?.startsWith('.'),
          `${file} imports a non-local module: ${specifier}`,
        ).toBe(true);
        const target = resolve(dirname(join(directory, file)), specifier!);
        const targetRelativePath = relative(directory, target);
        expect(
          !isAbsolute(targetRelativePath) &&
            targetRelativePath !== '..' &&
            !targetRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
          `${file} imports outside companion-contract: ${specifier}`,
        ).toBe(true);
      }
    }
  });
});
