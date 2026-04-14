import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserAction, ActionResult } from '../../../src/types.js';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { executeActions } from '../../../src/fetch/action-executor.js';

function mockPage() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue({ isVisible: () => true }),
    evaluate: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
    content: vi.fn().mockResolvedValue('<html><body>after actions</body></html>'),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
  } as unknown;
}

describe('executeActions', () => {
  let page: ReturnType<typeof mockPage>;

  beforeEach(() => {
    page = mockPage();
    vi.clearAllMocks();
  });

  it('returns empty results array for empty actions', async () => {
    const results = await executeActions(page as any, []);
    expect(results).toEqual([]);
  });

  it('returns empty results array for undefined actions', async () => {
    const results = await executeActions(page as any, undefined as any);
    expect(results).toEqual([]);
  });

  describe('click action', () => {
    it('calls page.click with the selector', async () => {
      const actions: BrowserAction[] = [{ type: 'click', selector: '.btn' }];
      const results = await executeActions(page as any, actions);
      expect((page as any).click).toHaveBeenCalledWith('.btn', expect.objectContaining({ timeout: expect.any(Number) }));
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].type).toBe('click');
      expect(results[0].action_index).toBe(0);
    });

    it('reports error when selector not found', async () => {
      (page as any).click.mockRejectedValue(new Error('Timeout exceeded: waiting for selector ".missing"'));
      const actions: BrowserAction[] = [{ type: 'click', selector: '.missing' }];
      const results = await executeActions(page as any, actions);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('.missing');
    });

    it('handles empty string selector gracefully', async () => {
      (page as any).click.mockRejectedValue(new Error('Selector cannot be empty'));
      const actions: BrowserAction[] = [{ type: 'click', selector: '' }];
      const results = await executeActions(page as any, actions);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBeDefined();
    });

    it('handles selector with special characters', async () => {
      const actions: BrowserAction[] = [{ type: 'click', selector: 'button[data-id="foo:bar"]' }];
      const results = await executeActions(page as any, actions);
      expect((page as any).click).toHaveBeenCalledWith('button[data-id="foo:bar"]', expect.any(Object));
      expect(results[0].success).toBe(true);
    });
  });

  describe('type action', () => {
    it('calls page.fill with selector and text', async () => {
      const actions: BrowserAction[] = [{ type: 'type', selector: '#email', text: 'user@test.com' }];
      const results = await executeActions(page as any, actions);
      expect((page as any).fill).toHaveBeenCalledWith('#email', 'user@test.com', expect.any(Object));
      expect(results[0].success).toBe(true);
      expect(results[0].type).toBe('type');
    });

    it('handles unicode text', async () => {
      const actions: BrowserAction[] = [{ type: 'type', selector: '#name', text: 'Tomas Muller' }];
      const results = await executeActions(page as any, actions);
      expect((page as any).fill).toHaveBeenCalledWith('#name', 'Tomas Muller', expect.any(Object));
      expect(results[0].success).toBe(true);
    });

    it('handles empty text', async () => {
      const actions: BrowserAction[] = [{ type: 'type', selector: '#field', text: '' }];
      const results = await executeActions(page as any, actions);
      expect((page as any).fill).toHaveBeenCalledWith('#field', '', expect.any(Object));
      expect(results[0].success).toBe(true);
    });

    it('handles very long text', async () => {
      const longText = 'A'.repeat(10000);
      const actions: BrowserAction[] = [{ type: 'type', selector: '#field', text: longText }];
      const results = await executeActions(page as any, actions);
      expect((page as any).fill).toHaveBeenCalledWith('#field', longText, expect.any(Object));
      expect(results[0].success).toBe(true);
    });

    it('reports error when selector not found', async () => {
      (page as any).fill.mockRejectedValue(new Error('Timeout exceeded'));
      const actions: BrowserAction[] = [{ type: 'type', selector: '#missing', text: 'data' }];
      const results = await executeActions(page as any, actions);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBeDefined();
    });
  });

  describe('wait action', () => {
    it('calls page.waitForTimeout with ms', async () => {
      const actions: BrowserAction[] = [{ type: 'wait', ms: 500 }];
      const results = await executeActions(page as any, actions);
      expect((page as any).waitForTimeout).toHaveBeenCalledWith(500);
      expect(results[0].success).toBe(true);
      expect(results[0].type).toBe('wait');
    });

    it('handles zero ms', async () => {
      const actions: BrowserAction[] = [{ type: 'wait', ms: 0 }];
      const results = await executeActions(page as any, actions);
      expect((page as any).waitForTimeout).toHaveBeenCalledWith(0);
      expect(results[0].success).toBe(true);
    });

    it('handles negative ms gracefully (clamps to 0)', async () => {
      const actions: BrowserAction[] = [{ type: 'wait', ms: -100 }];
      const results = await executeActions(page as any, actions);
      expect((page as any).waitForTimeout).toHaveBeenCalledWith(0);
      expect(results[0].success).toBe(true);
    });

    it('caps wait ms at 10000 to prevent stalling', async () => {
      const actions: BrowserAction[] = [{ type: 'wait', ms: 60000 }];
      const results = await executeActions(page as any, actions);
      expect((page as any).waitForTimeout).toHaveBeenCalledWith(10000);
      expect(results[0].success).toBe(true);
    });
  });

  describe('wait_for action', () => {
    it('calls page.waitForSelector with selector and timeout', async () => {
      const actions: BrowserAction[] = [{ type: 'wait_for', selector: '.loaded', timeout: 3000 }];
      const results = await executeActions(page as any, actions);
      expect((page as any).waitForSelector).toHaveBeenCalledWith('.loaded', expect.objectContaining({ timeout: 3000 }));
      expect(results[0].success).toBe(true);
    });

    it('uses default timeout when none specified', async () => {
      const actions: BrowserAction[] = [{ type: 'wait_for', selector: '.loaded' }];
      const results = await executeActions(page as any, actions);
      expect((page as any).waitForSelector).toHaveBeenCalledWith('.loaded', expect.objectContaining({ timeout: 5000 }));
      expect(results[0].success).toBe(true);
    });

    it('reports error on timeout', async () => {
      (page as any).waitForSelector.mockRejectedValue(new Error('Timeout 5000ms exceeded'));
      const actions: BrowserAction[] = [{ type: 'wait_for', selector: '.never-appears' }];
      const results = await executeActions(page as any, actions);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Timeout');
    });
  });

  describe('scroll action', () => {
    it('scrolls down by specified amount', async () => {
      const actions: BrowserAction[] = [{ type: 'scroll', direction: 'down', amount: 500 }];
      const results = await executeActions(page as any, actions);
      expect((page as any).evaluate).toHaveBeenCalled();
      expect(results[0].success).toBe(true);
      expect(results[0].type).toBe('scroll');
    });

    it('scrolls up by specified amount', async () => {
      const actions: BrowserAction[] = [{ type: 'scroll', direction: 'up', amount: 300 }];
      const results = await executeActions(page as any, actions);
      expect((page as any).evaluate).toHaveBeenCalled();
      expect(results[0].success).toBe(true);
    });

    it('scrolls by viewport height when no amount specified', async () => {
      const actions: BrowserAction[] = [{ type: 'scroll', direction: 'down' }];
      const results = await executeActions(page as any, actions);
      expect((page as any).evaluate).toHaveBeenCalled();
      expect(results[0].success).toBe(true);
    });

    it('reports error when evaluate fails', async () => {
      (page as any).evaluate.mockRejectedValue(new Error('Execution context was destroyed'));
      const actions: BrowserAction[] = [{ type: 'scroll', direction: 'down', amount: 100 }];
      const results = await executeActions(page as any, actions);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBeDefined();
    });
  });

  describe('screenshot action', () => {
    it('captures screenshot and returns base64', async () => {
      const actions: BrowserAction[] = [{ type: 'screenshot' }];
      const results = await executeActions(page as any, actions);
      expect((page as any).screenshot).toHaveBeenCalledWith({ fullPage: true });
      expect(results[0].success).toBe(true);
      expect(results[0].type).toBe('screenshot');
      expect(results[0].screenshot).toBeDefined();
      expect(typeof results[0].screenshot).toBe('string');
    });

    it('reports error when screenshot fails', async () => {
      (page as any).screenshot.mockRejectedValue(new Error('Page crashed'));
      const actions: BrowserAction[] = [{ type: 'screenshot' }];
      const results = await executeActions(page as any, actions);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Page crashed');
    });
  });

  describe('action chaining', () => {
    it('executes multiple actions in sequence', async () => {
      const callOrder: string[] = [];
      (page as any).waitForSelector.mockImplementation(async () => { callOrder.push('wait_for'); });
      (page as any).click.mockImplementation(async () => { callOrder.push('click'); });
      (page as any).waitForTimeout.mockImplementation(async () => { callOrder.push('wait'); });

      const actions: BrowserAction[] = [
        { type: 'wait_for', selector: '.banner', timeout: 3000 },
        { type: 'click', selector: '.accept' },
        { type: 'wait', ms: 500 },
      ];
      const results = await executeActions(page as any, actions);
      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
      expect(callOrder).toEqual(['wait_for', 'click', 'wait']);
    });

    it('continues executing remaining actions after a non-fatal failure', async () => {
      (page as any).click.mockRejectedValueOnce(new Error('Selector not found'));
      const actions: BrowserAction[] = [
        { type: 'click', selector: '.missing' },
        { type: 'wait', ms: 100 },
        { type: 'screenshot' },
      ];
      const results = await executeActions(page as any, actions);
      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);
    });

    it('preserves action_index for each result', async () => {
      const actions: BrowserAction[] = [
        { type: 'click', selector: '.a' },
        { type: 'click', selector: '.b' },
        { type: 'click', selector: '.c' },
      ];
      const results = await executeActions(page as any, actions);
      expect(results.map(r => r.action_index)).toEqual([0, 1, 2]);
    });

    it('handles a chain of 20 actions without issues', async () => {
      const actions: BrowserAction[] = Array.from({ length: 20 }, (_, i) => ({
        type: 'click' as const,
        selector: `.btn-${i}`,
      }));
      const results = await executeActions(page as any, actions);
      expect(results).toHaveLength(20);
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  describe('unknown action type', () => {
    it('reports error for unrecognized action type', async () => {
      const actions = [{ type: 'hover', selector: '.item' }] as unknown as BrowserAction[];
      const results = await executeActions(page as any, actions);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Unknown action type');
    });
  });

  describe('per-action timeout', () => {
    it('uses configurable per-action timeout for click', async () => {
      const actions: BrowserAction[] = [{ type: 'click', selector: '.btn' }];
      const results = await executeActions(page as any, actions, { perActionTimeoutMs: 2000 });
      expect((page as any).click).toHaveBeenCalledWith('.btn', expect.objectContaining({ timeout: 2000 }));
      expect(results[0].success).toBe(true);
    });

    it('defaults per-action timeout to 5000ms', async () => {
      const actions: BrowserAction[] = [{ type: 'click', selector: '.btn' }];
      await executeActions(page as any, actions);
      expect((page as any).click).toHaveBeenCalledWith('.btn', expect.objectContaining({ timeout: 5000 }));
    });
  });
});
