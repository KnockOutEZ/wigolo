import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtractOutput } from '../../../../src/types.js';
import type { SmartRouter } from '../../../../src/fetch/router.js';

vi.mock('../../../../src/tools/extract.js', () => ({
  handleExtract: vi.fn(),
}));

import { handleExtract } from '../../../../src/tools/extract.js';
import { executeExtract } from '../../../../src/repl/commands/extract.js';
import type { ReplDeps } from '../../../../src/repl/commands/types.js';

const mockRouter = {} as SmartRouter;
const deps: ReplDeps = { router: mockRouter, engines: [], backendStatus: {} as any };

describe('executeExtract', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const baseOutput: ExtractOutput = {
    data: { title: 'My Page' },
    mode: 'metadata',
  };

  it('passes url from positional args', async () => {
    vi.mocked(handleExtract).mockResolvedValue(baseOutput);
    const result = await executeExtract({ command: 'extract', positional: ['https://ex.com'], flags: {} }, deps);
    expect(handleExtract).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://ex.com' }),
      mockRouter,
    );
    expect(result).toEqual(baseOutput);
  });

  it('maps --mode flag', async () => {
    vi.mocked(handleExtract).mockResolvedValue(baseOutput);
    await executeExtract({ command: 'extract', positional: ['https://ex.com'], flags: { mode: 'tables' } }, deps);
    expect(handleExtract).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'tables' }),
      expect.anything(),
    );
  });

  it('maps --selector flag to css_selector', async () => {
    vi.mocked(handleExtract).mockResolvedValue(baseOutput);
    await executeExtract({ command: 'extract', positional: ['https://ex.com'], flags: { mode: 'selector', selector: '.content' } }, deps);
    expect(handleExtract).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'selector', css_selector: '.content' }),
      expect.anything(),
    );
  });

  it('returns error when no URL provided', async () => {
    const result = await executeExtract({ command: 'extract', positional: [], flags: {} }, deps);
    expect(result.error).toContain('URL');
  });

  it('handles handler exceptions', async () => {
    vi.mocked(handleExtract).mockRejectedValue(new Error('invalid selector'));
    const result = await executeExtract({ command: 'extract', positional: ['https://ex.com'], flags: {} }, deps);
    expect(result.error).toContain('invalid selector');
  });
});
