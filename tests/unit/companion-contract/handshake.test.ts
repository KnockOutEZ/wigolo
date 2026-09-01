import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COMPANION_CONTRACT_VERSION,
  evaluateHandshake,
} from '../../../src/companion-contract/index.js';
import type {
  CompanionHello,
  CompanionHelloApp,
  HandshakeResult,
} from '../../../src/companion-contract/index.js';

function handshake(
  external: CompanionHello,
  app: CompanionHelloApp,
): HandshakeResult {
  return evaluateHandshake(external, app);
}

describe('companion handshake', () => {
  it.each([
    {
      externalVersion: '2.0.0',
      appVersion: '1.4.0',
      hint: 'update_studio',
    },
    {
      externalVersion: '1.4.0',
      appVersion: '2.0.0',
      hint: 'update_wigolo',
    },
  ] as const)(
    'refuses on contract MAJOR mismatch and returns $hint for the older side',
    ({ externalVersion, appVersion, hint }) => {
      const result = handshake(
        { contractVersion: externalVersion, schemaHead: 18, capabilities: [] },
        {
          contractVersion: appVersion,
          schemaHead: 18,
          minSchemaHead: 16,
          capabilities: [],
        },
      );

      expect(result).toEqual({
        ok: false,
        reason: 'contract_major_mismatch',
        hint,
      });
    },
  );

  it.each([
    ['1.9.0', '1.4.0'],
    ['1.4.0', '1.9.0'],
  ])(
    'accepts MINOR skew (%s vs %s) and ignores unknown capability flags',
    (externalVersion, appVersion) => {
      const result = handshake(
        {
          contractVersion: externalVersion,
          schemaHead: 18,
          capabilities: ['future-external-flag'],
        },
        {
          contractVersion: appVersion,
          schemaHead: 18,
          minSchemaHead: 16,
          capabilities: ['future-app-flag'],
        },
      );

      expect(result).toEqual({ ok: true });
    },
  );

  it('refuses when the external schema head is below the app minimum', () => {
    const result = handshake(
      { contractVersion: '1.0.0', schemaHead: 15, capabilities: [] },
      {
        contractVersion: '1.0.0',
        schemaHead: 18,
        minSchemaHead: 16,
        capabilities: [],
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'schema_too_old',
      hint: 'update_wigolo',
    });
  });

  it('accepts an external schema head newer than the app knows when contract MAJOR matches', () => {
    const result = handshake(
      { contractVersion: '1.7.0', schemaHead: 20, capabilities: [] },
      {
        contractVersion: '1.4.0',
        schemaHead: 18,
        minSchemaHead: 16,
        capabilities: [],
      },
    );

    expect(result).toEqual({ ok: true });
  });

  it('accepts an external schema head exactly at the app minimum', () => {
    const result = handshake(
      { contractVersion: '1.0.0', schemaHead: 16, capabilities: [] },
      {
        contractVersion: '1.0.0',
        schemaHead: 18,
        minSchemaHead: 16,
        capabilities: [],
      },
    );

    expect(result).toEqual({ ok: true });
  });

  it('refuses a newer external schema when the contract MAJOR differs', () => {
    const result = handshake(
      { contractVersion: '2.0.0', schemaHead: 20, capabilities: [] },
      {
        contractVersion: '1.9.0',
        schemaHead: 18,
        minSchemaHead: 16,
        capabilities: [],
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'contract_major_mismatch',
      hint: 'update_studio',
    });
  });

  it('exports the pinned semver contract version', () => {
    expect(COMPANION_CONTRACT_VERSION).toBe('1.0.0');
    expect(COMPANION_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
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
