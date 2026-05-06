import { describe, it, expectTypeOf } from 'vitest';
import type { StageResult } from '../../../src/types.js';
import type { handleSearch } from '../../../src/tools/search.js';

describe('StageResult', () => {
  it('discriminates ok=true (data) from ok=false (error)', () => {
    const ok: StageResult<{ n: number }> = { ok: true, data: { n: 1 } };
    const err: StageResult<{ n: number }> = {
      ok: false, error: 'no_content', error_reason: 'r', stage: 'synthesize',
    };
    expectTypeOf(ok).toMatchTypeOf<StageResult<{ n: number }>>();
    expectTypeOf(err).toMatchTypeOf<StageResult<{ n: number }>>();
  });

  it('rejects ok=true without data at the type level', () => {
    // @ts-expect-error data is required when ok is true
    const bad: StageResult<{ n: number }> = { ok: true };
    void bad;
  });

  it('rejects ok=false without error_reason at the type level', () => {
    // @ts-expect-error error_reason required
    const bad: StageResult<{ n: number }> = { ok: false, error: 'x', stage: 's' };
    void bad;
  });

  it('handleSearch return type is StageResult-compatible', () => {
    type Ret = Awaited<ReturnType<typeof handleSearch>>;
    const sample: Ret = { ok: false, error: 'x', error_reason: 'y', stage: 'z' } as Ret;
    void sample;
  });
});
