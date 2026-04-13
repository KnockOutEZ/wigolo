import { describe, it, expect } from 'vitest';
import { waitFor } from '../../helpers/wait-for.js';

describe('waitFor', () => {
  it('resolves with a sync predicate once it returns truthy', async () => {
    let count = 0;
    const result = await waitFor(() => {
      count++;
      return count >= 3 ? 'done' : false;
    }, { timeoutMs: 1000, intervalMs: 5 });
    expect(result).toBe('done');
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('resolves with an async predicate once it returns truthy', async () => {
    let count = 0;
    const result = await waitFor(async () => {
      count++;
      return count >= 3 ? 'async-done' : false;
    }, { timeoutMs: 1000, intervalMs: 5 });
    expect(result).toBe('async-done');
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('throws on timeout', async () => {
    await expect(waitFor(() => false, { timeoutMs: 30, intervalMs: 5 }))
      .rejects.toThrow(/timed out/);
  });
});
