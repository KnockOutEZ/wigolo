import { describe, it, expect } from 'vitest';
import { browserCategory } from '../../../../../src/cli/tui/schema/browser.js';

describe('browserCategory', () => {
  it('declares chromium-only options with futureNote', () => {
    expect(browserCategory.id).toBe('browser');
    const engine = browserCategory.fields.find((f) => f.key === 'WIGOLO_BROWSER_TYPES');
    expect(engine).toBeDefined();
    expect(engine?.kind).toBe('select');
    expect(engine?.options?.map((o) => o.value)).toEqual(['chromium']);
    expect(engine?.futureNote).toMatch(/coming soon/i);
  });

  it('includes max concurrent + idle timeout fields with sane ranges', () => {
    const max = browserCategory.fields.find((f) => f.key === 'WIGOLO_MAX_BROWSERS');
    expect(max?.kind).toBe('number');
    expect(max?.min).toBe(1);
    expect(max?.max).toBe(16);

    const idle = browserCategory.fields.find((f) => f.key === 'WIGOLO_BROWSER_IDLE_TIMEOUT_MS');
    expect(idle?.kind).toBe('number');
    expect(idle?.min).toBeGreaterThanOrEqual(1000);
  });

  it('every field has a settingsPath, label, and default', () => {
    for (const f of browserCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
      expect(f.default, `field ${f.key} missing default`).toBeDefined();
    }
  });
});
