import { describe, it, expect } from 'vitest';
import { describeNativeError, toActionableNativeError, currentAbi } from '../../src/native-check.js';

/**
 * WHY: the ABI-mismatch message is the entire user-facing value of #220 — if it
 * stops recognising Node's wording, the failure silently reverts to a raw stack
 * that names neither runtime. These rows pin the real error strings.
 */

// Verbatim shape Node emits when a native addon is loaded under the wrong ABI.
const ABI_ERROR =
  "Error: The module '/Users/x/.cursor/tools/wigolo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
  'was compiled against a different Node.js version using\n' +
  'NODE_MODULE_VERSION 137. This version of Node.js requires\n' +
  'NODE_MODULE_VERSION 127. Please try re-compiling or re-installing\n' +
  'the module (for instance, using `npm rebuild` or `npm install`).';

describe('describeNativeError', () => {
  it('classifies an ABI mismatch and names both runtimes', () => {
    const failure = describeNativeError(new Error(ABI_ERROR));

    expect(failure?.kind).toBe('abi-mismatch');
    expect(failure?.compiledFor).toBe('137');
    expect(failure?.requires).toBe('127');
    expect(failure?.message).toContain('ABI 137');
    expect(failure?.message).toContain('ABI 127');
  });

  it('tells the user how to get out of it', () => {
    const failure = describeNativeError(new Error(ABI_ERROR));

    expect(failure?.message).toContain('npm rebuild better-sqlite3');
    expect(failure?.message).toContain('dist/index.js');
  });

  it('classifies a missing binding separately from a mismatch', () => {
    const failure = describeNativeError(
      new Error('Could not locate the bindings file. Tried:\n → /tmp/x/better_sqlite3.node'),
    );

    expect(failure?.kind).toBe('missing-binding');
    expect(failure?.requires).toBe(currentAbi());
  });

  it('falls back to the current ABI when only one version is named', () => {
    const failure = describeNativeError(
      new Error('was compiled against a different Node.js version using NODE_MODULE_VERSION 115.'),
    );

    expect(failure?.compiledFor).toBe('115');
    expect(failure?.requires).toBe(currentAbi());
  });

  it('leaves unrelated errors alone', () => {
    expect(describeNativeError(new Error('SQLITE_CANTOPEN: unable to open database file'))).toBeUndefined();
    expect(describeNativeError('disk full')).toBeUndefined();
  });

  it('names the module it was asked about', () => {
    const failure = describeNativeError(new Error(ABI_ERROR), 'onnxruntime-node');

    expect(failure?.message).toContain('onnxruntime-node');
  });
});

describe('toActionableNativeError', () => {
  it('replaces a native failure with the actionable message and keeps the cause', () => {
    const original = new Error(ABI_ERROR);
    const wrapped = toActionableNativeError(original);

    expect(wrapped).toBeInstanceOf(Error);
    expect((wrapped as Error).message).toContain('installed by one Node');
    expect((wrapped as Error).cause).toBe(original);
  });

  it('passes non-native errors straight through', () => {
    const original = new Error('SQLITE_CORRUPT: database disk image is malformed');

    expect(toActionableNativeError(original)).toBe(original);
  });
});
