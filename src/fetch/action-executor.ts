import { createLogger } from '../logger.js';
import type { BrowserAction, ActionResult } from '../types.js';

const log = createLogger('fetch');

const DEFAULT_PER_ACTION_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 5000;

export interface ActionExecutorOptions {
  perActionTimeoutMs?: number;
}

interface PlaywrightPage {
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  waitForTimeout(timeout: number): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  evaluate(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown>;
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
  viewportSize(): { width: number; height: number } | null;
}

export async function executeActions(
  page: PlaywrightPage,
  actions: BrowserAction[] | undefined | null,
  opts?: ActionExecutorOptions,
): Promise<ActionResult[]> {
  if (!actions || actions.length === 0) {
    return [];
  }

  const perActionTimeout = opts?.perActionTimeoutMs ?? DEFAULT_PER_ACTION_TIMEOUT_MS;
  const results: ActionResult[] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const result: ActionResult = {
      action_index: i,
      type: action.type,
      success: false,
    };

    try {
      switch (action.type) {
        case 'click': {
          log.debug('action: click', { index: i, selector: action.selector });
          await page.click(action.selector, { timeout: perActionTimeout });
          result.success = true;
          break;
        }

        case 'type': {
          log.debug('action: type', { index: i, selector: action.selector, textLength: action.text.length });
          await page.fill(action.selector, action.text, { timeout: perActionTimeout });
          result.success = true;
          break;
        }

        case 'wait': {
          const MAX_WAIT_MS = 10000;
          const ms = Math.min(Math.max(0, action.ms), MAX_WAIT_MS);
          log.debug('action: wait', { index: i, ms });
          await page.waitForTimeout(ms);
          result.success = true;
          break;
        }

        case 'wait_for': {
          const timeout = action.timeout ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
          log.debug('action: wait_for', { index: i, selector: action.selector, timeout });
          await page.waitForSelector(action.selector, { timeout });
          result.success = true;
          break;
        }

        case 'scroll': {
          const viewport = page.viewportSize();
          const defaultAmount = viewport?.height ?? 720;
          const pixels = action.amount ?? defaultAmount;
          const scrollY = action.direction === 'up' ? -pixels : pixels;
          log.debug('action: scroll', { index: i, direction: action.direction, pixels: scrollY });
          await page.evaluate((dy: unknown) => window.scrollBy(0, dy as number), scrollY);
          result.success = true;
          break;
        }

        case 'screenshot': {
          log.debug('action: screenshot', { index: i });
          const buf = await page.screenshot({ fullPage: true });
          result.success = true;
          result.screenshot = buf.toString('base64');
          break;
        }

        default: {
          const unknownType = (action as { type: string }).type;
          log.warn('unknown action type', { index: i, type: unknownType });
          result.error = `Unknown action type: ${unknownType}`;
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('action failed', { index: i, type: action.type, error: message });
      result.error = message;
    }

    results.push(result);
  }

  log.info('actions complete', {
    total: actions.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
  });

  return results;
}
