import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isNativeAbiMismatch,
  formatNativeAbiMismatch,
  explainNativeLoadError,
} from '../../../src/util/native-abi.js';

// Shape of the real dlopen failure Node throws for a mismatched addon.
function fakeAbiError(): Error {
  const err = new Error(
    "The module '/opt/tools/lib/node_modules/wigolo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
      'was compiled against a different Node.js version using\n' +
      'NODE_MODULE_VERSION 137. This version of Node.js requires\n' +
      'NODE_MODULE_VERSION 127. Please try re-compiling or re-installing\n' +
      'the module (for instance, using `npm rebuild` or `npm install`).',
  ) as NodeJS.ErrnoException;
  err.code = 'ERR_DLOPEN_FAILED';
  return err;
}

const runtime = { version: 'v22.22.0', execPath: '/editor/bin/node', abi: '127' };

describe('isNativeAbiMismatch', () => {
  it('detects the NODE_MODULE_VERSION dlopen error', () => {
    expect(isNativeAbiMismatch(fakeAbiError())).toBe(true);
  });

  it('ignores unrelated errors and non-errors', () => {
    expect(isNativeAbiMismatch(new Error('SQLITE_CANTOPEN: unable to open database file'))).toBe(false);
    expect(isNativeAbiMismatch('NODE_MODULE_VERSION 137')).toBe(false);
    expect(isNativeAbiMismatch(undefined)).toBe(false);
  });
});

describe('formatNativeAbiMismatch', () => {
  it('names the running Node, both ABIs, and the fixes', () => {
    const msg = formatNativeAbiMismatch(fakeAbiError(), 'better-sqlite3', runtime);
    expect(msg).toContain('Node v22.22.0');
    expect(msg).toContain('/editor/bin/node');
    expect(msg).toContain('NODE_MODULE_VERSION 127');
    expect(msg).toContain('compiled for NODE_MODULE_VERSION 137');
    expect(msg).toContain('cd "/opt/tools/lib/node_modules/wigolo" && npm rebuild better-sqlite3');
    expect(msg).toContain('npx -y wigolo');
    expect(msg).toContain('MCP client');
  });

  it('falls back to generic guidance when the message has no path/versions', () => {
    const msg = formatNativeAbiMismatch(
      new Error('was compiled against a different Node.js version'),
      'better-sqlite3',
      runtime,
    );
    expect(msg).toContain("`npm rebuild better-sqlite3` in wigolo's install directory");
    expect(msg).toContain('compiled for another Node.js version');
  });
});

describe('explainNativeLoadError', () => {
  it('wraps a mismatch, keeping the original as cause and the code', () => {
    const original = fakeAbiError();
    const out = explainNativeLoadError(original) as NodeJS.ErrnoException;
    expect(out).not.toBe(original);
    expect(out.message).toContain('built for a different Node.js version');
    expect(out.cause).toBe(original);
    expect(out.code).toBe('ERR_DLOPEN_FAILED');
  });

  it('passes other errors through untouched', () => {
    const other = new Error('disk full');
    expect(explainNativeLoadError(other)).toBe(other);
  });
});

describe('initDatabase on an ABI mismatch', () => {
  afterEach(() => {
    vi.doUnmock('better-sqlite3');
    vi.resetModules();
  });

  it('rethrows the friendly message', async () => {
    vi.resetModules();
    vi.doMock('better-sqlite3', () => ({
      default: class {
        constructor() {
          throw fakeAbiError();
        }
      },
    }));
    const { initDatabase } = await import('../../../src/cache/db.js');
    expect(() => initDatabase(':memory:')).toThrow(/built for a different Node\.js version/);
  });
});
