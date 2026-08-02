import { describe, it, expect } from 'vitest';
import { advancedCategory } from '../../../../../src/cli/tui/schema/advanced.js';

describe('advancedCategory', () => {
  it('has id advanced and eight fields (incl. opt-in escape-hatch URLs)', () => {
    expect(advancedCategory.id).toBe('advanced');
    expect(advancedCategory.fields.length).toBe(8);
    const keys = advancedCategory.fields.map((f) => f.key);
    expect(keys).toEqual([
      'WIGOLO_LOG_LEVEL',
      'PROXY_URL',
      'USE_PROXY',
      'WIGOLO_SOLVER_URL',
      'WIGOLO_HOSTED_READER_URL',
      'USER_AGENT',
      'WIGOLO_DAEMON_PORT',
      'WIGOLO_DAEMON_HOST',
    ]);
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

  it('WIGOLO_LOG_LEVEL is select with all four levels and defaults to info', () => {
    const f = advancedCategory.fields.find((x) => x.key === 'WIGOLO_LOG_LEVEL');
    expect(f?.kind).toBe('select');
    expect(f?.default).toBe('info');
    expect(f?.options?.map((o) => o.value)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('USE_PROXY toggle defaults to false', () => {
    const f = advancedCategory.fields.find((x) => x.key === 'USE_PROXY');
    expect(f?.kind).toBe('toggle');
    expect(f?.default).toBe(false);
  });

  it('PROXY_URL and USER_AGENT are text fields with help text', () => {
    const proxy = advancedCategory.fields.find((x) => x.key === 'PROXY_URL');
    expect(proxy?.kind).toBe('text');
    expect(proxy?.help).toBeTruthy();
    const ua = advancedCategory.fields.find((x) => x.key === 'USER_AGENT');
    expect(ua?.kind).toBe('text');
    expect(ua?.help).toBeTruthy();
  });

  it('WIGOLO_DAEMON_PORT is a number defaulting to 7777 within 1024-65535', () => {
    const f = advancedCategory.fields.find((x) => x.key === 'WIGOLO_DAEMON_PORT');
    expect(f?.kind).toBe('number');
    expect(f?.default).toBe(7777);
    expect(f?.min).toBe(1024);
    expect(f?.max).toBe(65535);
  });

  it('WIGOLO_DAEMON_HOST is a text field defaulting to 127.0.0.1', () => {
    const f = advancedCategory.fields.find((x) => x.key === 'WIGOLO_DAEMON_HOST');
    expect(f?.kind).toBe('text');
    expect(f?.default).toBe('127.0.0.1');
  });

  it('every field has settingsPath + label', () => {
    for (const f of advancedCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
    }
  });
});
