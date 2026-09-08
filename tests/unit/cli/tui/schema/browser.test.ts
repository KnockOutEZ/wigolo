import { describe, it, expect } from 'vitest';
import { browserCategory } from '../../../../../src/cli/tui/schema/browser.js';
import { configKeyBySettingsKey } from '../../../../../src/config.js';

/** The registry is the only place a default or an env-var name is declared. */
function registered(settingsKey: string) {
  const def = configKeyBySettingsKey(settingsKey);
  expect(def, `${settingsKey} missing from CONFIG_KEYS`).toBeDefined();
  return def!;
}


describe('browserCategory', () => {
  it('declares chromium-only options with futureNote', () => {
    expect(browserCategory.id).toBe('browser');
    const engine = browserCategory.fields.find((f) => f.settingsPath === 'browserTypes');
    expect(engine).toBeDefined();
    expect(engine?.kind).toBe('select');
    expect(engine?.options?.map((o) => o.value)).toEqual(['chromium']);
    expect(engine?.futureNote).toMatch(/coming soon/i);
  });

  it('includes max concurrent + idle timeout fields with sane ranges', () => {
    const max = browserCategory.fields.find((f) => f.settingsPath === 'maxBrowsers');
    expect(max?.kind).toBe('number');
    expect(max?.min).toBe(1);
    expect(max?.max).toBe(16);

    const idle = browserCategory.fields.find((f) => f.settingsPath === 'browserIdleTimeoutMs');
    expect(idle?.kind).toBe('number');
    expect(idle?.min).toBeGreaterThanOrEqual(1000);
  });

  it('prints the env var the resolver reads, not the WIGOLO_-prefixed invention', () => {
    // Both of these were printed as WIGOLO_MAX_BROWSERS /
    // WIGOLO_BROWSER_IDLE_TIMEOUT_MS, which nothing reads, and the same names
    // were written into every agent's MCP env block.
    const byKey = Object.fromEntries(browserCategory.fields.map((f) => [f.settingsPath, f.key]));
    expect(byKey.maxBrowsers).toBe('MAX_BROWSERS');
    expect(byKey.browserIdleTimeoutMs).toBe('BROWSER_IDLE_TIMEOUT');
    for (const f of browserCategory.fields) {
      expect(f.key).toBe(registered(f.settingsPath).envVar ?? f.settingsPath);
      expect(f.default).toEqual(registered(f.settingsPath).default);
    }
  });

  it('every field has a settingsPath, label, and default', () => {
    for (const f of browserCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
      expect(f.default, `field ${f.key} missing default`).toBeDefined();
    }
  });
});
