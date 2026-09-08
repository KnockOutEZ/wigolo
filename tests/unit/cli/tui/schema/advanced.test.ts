import { describe, it, expect } from 'vitest';
import { advancedCategory } from '../../../../../src/cli/tui/schema/advanced.js';
import { configKeyBySettingsKey } from '../../../../../src/config.js';

/** The registry is the only place a default or an env-var name is declared. */
function registered(settingsKey: string) {
  const def = configKeyBySettingsKey(settingsKey);
  expect(def, `${settingsKey} missing from CONFIG_KEYS`).toBeDefined();
  return def!;
}


describe('advancedCategory', () => {
  it('has id advanced and ten fields (incl. opt-in escape-hatch URLs, accounts service + telemetry)', () => {
    expect(advancedCategory.id).toBe('advanced');
    expect(advancedCategory.fields.length).toBe(10);
    const keys = advancedCategory.fields.map((f) => f.key);
    expect(keys).toEqual([
      'LOG_LEVEL',
      'PROXY_URL',
      'USE_PROXY',
      'WIGOLO_SOLVER_URL',
      'WIGOLO_HOSTED_READER_URL',
      'USER_AGENT',
      'WIGOLO_DAEMON_PORT',
      'WIGOLO_ACCOUNTS_URL',
      'WIGOLO_TELEMETRY',
      'WIGOLO_DAEMON_HOST',
    ]);
  });

  it('telemetry is a default-on toggle whose help names the opt-out and the Never list', () => {
    const telemetry = advancedCategory.fields.find((x) => x.settingsPath === 'telemetryEnabled');
    expect(telemetry?.kind).toBe('toggle');
    expect(telemetry?.settingsPath).toBe('telemetryEnabled');
    // Opt-OUT as of 0.3.0: the toggle has to arrive already on, or the catalog would
    // contradict the resolver.
    expect(telemetry?.default).toBe(registered('telemetryEnabled').default);
    expect(telemetry?.default).toBe(true);
    expect(telemetry?.help).toMatch(/WIGOLO_TELEMETRY=off/);
    expect(telemetry?.help).toMatch(/Never page content/);
    // Capability language: no provider, library or service-implementation name.
    expect(telemetry?.help).not.toMatch(/playwright|searxng|posthog|segment/i);
    // Every batch is authorised as the account, so the counters are attributed to it.
    // The shipped help said "anonymous" and "to your account" in one sentence.
    expect(telemetry?.help).not.toMatch(/anonymous|anonymised|anonymized/i);
  });

  it('solver + reader URL fields are opt-in text fields with capability-language help', () => {
    const solver = advancedCategory.fields.find((x) => x.key === 'WIGOLO_SOLVER_URL');
    expect(solver?.kind).toBe('text');
    expect(solver?.settingsPath).toBe('solverUrl');
    expect(solver?.help).toBeTruthy();
    const reader = advancedCategory.fields.find((x) => x.key === 'WIGOLO_HOSTED_READER_URL');
    expect(reader?.kind).toBe('text');
    expect(reader?.settingsPath).toBe('hostedReaderUrl');
    expect(reader?.help).toBeTruthy();
  });

  it('log level is a select over all four levels, printed as the env var the resolver reads', () => {
    const f = advancedCategory.fields.find((x) => x.settingsPath === 'logLevel');
    expect(f?.kind).toBe('select');
    // Was printed and propagated as WIGOLO_LOG_LEVEL, which nothing reads.
    expect(f?.key).toBe('LOG_LEVEL');
    expect(f?.default).toBe(registered('logLevel').default);
    expect(f?.options?.map((o) => o.value)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('USE_PROXY toggle defaults to false', () => {
    const f = advancedCategory.fields.find((x) => x.settingsPath === 'useProxy');
    expect(f?.kind).toBe('toggle');
    expect(f?.default).toBe(registered('useProxy').default);
    expect(f?.default).toBe(false);
  });

  it('every field agrees with the registry on identifier and default', () => {
    for (const f of advancedCategory.fields) {
      const def = registered(f.settingsPath);
      expect(f.key, `${f.settingsPath} prints an identifier of its own`).toBe(
        def.envVar ?? f.settingsPath,
      );
      const editable = def.sentinelDefault === true || f.kind === 'masked' ? undefined : def.default;
      expect(f.default, `${f.settingsPath} default drifts from the resolver`).toEqual(editable);
    }
  });

  it('describes the proxy field as bring-your-own, never as a resold pool', () => {
    const proxy = advancedCategory.fields.find((x) => x.settingsPath === 'proxyUrl');
    expect(proxy?.help ?? '').not.toMatch(/residential|rotating|pool of/i);
  });

  it('PROXY_URL and USER_AGENT are text fields with help text', () => {
    const proxy = advancedCategory.fields.find((x) => x.key === 'PROXY_URL');
    expect(proxy?.kind).toBe('text');
    expect(proxy?.help).toBeTruthy();
    const ua = advancedCategory.fields.find((x) => x.key === 'USER_AGENT');
    expect(ua?.kind).toBe('text');
    expect(ua?.help).toBeTruthy();
  });

  it('daemon port is a number taking the resolver default, within 1024-65535', () => {
    const f = advancedCategory.fields.find((x) => x.settingsPath === 'daemonPort');
    expect(f?.kind).toBe('number');
    // The catalog said 7777; the resolver has always used 3333.
    expect(f?.default).toBe(registered('daemonPort').default);
    expect(f?.min).toBe(1024);
    expect(f?.max).toBe(65535);
  });

  it('WIGOLO_DAEMON_HOST is a text field defaulting to 127.0.0.1', () => {
    const f = advancedCategory.fields.find((x) => x.key === 'WIGOLO_DAEMON_HOST');
    expect(f?.kind).toBe('text');
    expect(f?.default).toBe('127.0.0.1');
  });

  it('WIGOLO_ACCOUNTS_URL is an optional text field mapped to accountsUrl', () => {
    const f = advancedCategory.fields.find((x) => x.settingsPath === 'accountsUrl');
    expect(f?.kind).toBe('text');
    expect(f?.key).toBe('WIGOLO_ACCOUNTS_URL');
    expect(f?.help).toBeTruthy();
    // No editable `default`: the editor persists the value it starts from, and
    // repeating a sentinel hostname in the picker would invite someone to save
    // it. The registry still knows the resolver's fallback, and a read-only
    // print shows it, so the two surfaces disagree about nothing.
    expect(f?.default).toBeUndefined();
    expect(registered('accountsUrl').sentinelDefault).toBe(true);
    expect(f?.defaultDisplay).toContain(String(registered('accountsUrl').default));
  });

  it('every field has settingsPath + label', () => {
    for (const f of advancedCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
    }
  });
});
