import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import {
  getDomainRouting,
  recordTlsImpersonationSuccess,
} from '../../../src/cache/store.js';

describe('domain_routing — TLS-impersonation columns', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('migrates the new columns onto domain_routing', () => {
    const db = getDatabase();
    const cols = db.pragma('table_info(domain_routing)') as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toContain('prefer_tls_impersonation');
    expect(names).toContain('tls_success_count');
    expect(names).toContain('prefer_playwright'); // legacy column survives
  });

  it('getDomainRouting returns null for an unknown domain', () => {
    expect(getDomainRouting('unknown.com')).toBeNull();
  });

  it('recordTlsImpersonationSuccess inserts a row and increments tls_success_count', () => {
    const after1 = recordTlsImpersonationSuccess('example.com', 3);
    expect(after1).not.toBeNull();
    expect(after1!.tlsSuccessCount).toBe(1);
    expect(after1!.preferTlsImpersonation).toBe(false);

    const after2 = recordTlsImpersonationSuccess('example.com', 3);
    expect(after2!.tlsSuccessCount).toBe(2);
    expect(after2!.preferTlsImpersonation).toBe(false);
  });

  it('flips prefer_tls_impersonation to 1 once threshold is reached', () => {
    recordTlsImpersonationSuccess('promote.com', 3);
    recordTlsImpersonationSuccess('promote.com', 3);
    const after3 = recordTlsImpersonationSuccess('promote.com', 3);
    expect(after3!.tlsSuccessCount).toBe(3);
    expect(after3!.preferTlsImpersonation).toBe(true);
  });

  it('keeps prefer_tls_impersonation=1 once flipped (does not regress)', () => {
    for (let i = 0; i < 3; i++) recordTlsImpersonationSuccess('sticky.com', 3);
    const stickyAfter3 = recordTlsImpersonationSuccess('sticky.com', 3);
    expect(stickyAfter3!.preferTlsImpersonation).toBe(true);
    const stickyAfter4 = recordTlsImpersonationSuccess('sticky.com', 3);
    expect(stickyAfter4!.preferTlsImpersonation).toBe(true);
    expect(stickyAfter4!.tlsSuccessCount).toBe(5);
  });

  it('respects a custom threshold per call', () => {
    const after1 = recordTlsImpersonationSuccess('low-bar.com', 1);
    expect(after1!.preferTlsImpersonation).toBe(true);
  });
});
