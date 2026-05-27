/**
 * Tests for SP4 doctor output: provider, key location, and masked value display.
 * Keys must never appear unmasked in doctor output.
 */
import { describe, it, expect } from 'vitest';
import { maskApiKey, formatProviderDoctorLines } from '../../../src/cli/doctor.js';

describe('maskApiKey', () => {
  it('masks a typical API key showing only prefix', () => {
    const masked = maskApiKey('sk-ant-api03-abcdefghij12345678');
    expect(masked).toMatch(/\*/);
    expect(masked).not.toContain('abcdefghij12345678');
  });

  it('masks a short key entirely', () => {
    const masked = maskApiKey('abc');
    expect(masked).toMatch(/\*/);
    expect(masked).not.toBe('abc');
  });

  it('handles empty string', () => {
    const masked = maskApiKey('');
    expect(typeof masked).toBe('string');
  });

  it('never returns the full key', () => {
    const key = 'sk-openai-super-secret-do-not-leak';
    const masked = maskApiKey(key);
    expect(masked).not.toBe(key);
    // Show at most 8 chars of prefix
    expect(masked.replace(/\*/g, '').length).toBeLessThanOrEqual(8);
  });
});

describe('formatProviderDoctorLines', () => {
  it('includes provider name and location', () => {
    const lines = formatProviderDoctorLines('anthropic', 'keychain', 'sk-ant-secret');
    const joined = lines.join('\n');
    expect(joined).toContain('anthropic');
    expect(joined).toContain('keychain');
  });

  it('never includes the raw key value', () => {
    const secret = 'sk-ant-api03-super-secret-key-value';
    const lines = formatProviderDoctorLines('anthropic', 'keychain', secret);
    const joined = lines.join('\n');
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain('super-secret-key-value');
  });

  it('shows masked form', () => {
    const lines = formatProviderDoctorLines('openai', 'file', 'sk-openai-12345678');
    const joined = lines.join('\n');
    expect(joined).toMatch(/\*/);
  });
});
