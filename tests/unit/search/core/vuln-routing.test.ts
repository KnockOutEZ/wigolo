import { describe, it, expect } from 'vitest';
import { classifyIntentDetailed } from '../../../../src/search/core/intent-router.js';

describe('intent-router — vulnerabilities', () => {
  it.each([
    'CVE-2024-12345',
    'cve-2023-999',
    'GHSA-abcd-1234-efgh',
  ])('routes explicit vulnerability identifier: %s', (query: string) => {
    expect(classifyIntentDetailed(query).vertical).toBe('vulnerabilities');
  });

  it.each([
    'NVD advisory apache',
    'microsoft patch tuesday',
    'what is cwe-79',
  ])('routes unambiguous vulnerability query: %s', (query: string) => {
    expect(classifyIntentDetailed(query).vertical).toBe('vulnerabilities');
  });

  it.each([
    'emotional vulnerability',
    'financial advisory services',
    'exploit a loophole',
    'vulnerability in leadership',
    'advisory board meeting',
  ])('does not over-fire on: %s', (query: string) => {
    expect(classifyIntentDetailed(query).vertical).not.toBe('vulnerabilities');
  });

  it('does not over-trigger on general security terms', () => {
    expect(classifyIntentDetailed('python security best practices').vertical).toBe('general');
  });

  it('allows overriding via hint', () => {
    expect(
      classifyIntentDetailed('some completely unrelated query', {
        hint: 'vulnerabilities',
      }).vertical,
    ).toBe('vulnerabilities');
  });

  it.each([
    'explain GHSA-abcd-1234-efgh',
    'GHSA-abcd-1234-efgh details',
  ])('routes embedded GHSA identifier: %s', (query: string) => {
    expect(classifyIntentDetailed(query).vertical).toBe('vulnerabilities');
  });

  it.each([
    'fix CVE-2024-1234 in python',
    'CVE-2024-1234 details',
  ])('routes embedded CVE identifier: %s', (query: string) => {
    expect(classifyIntentDetailed(query).vertical).toBe('vulnerabilities');
  });

  it.each([
    'CVE-2024-1234 python',
    'fix python CVE-2024-1234',
  ])('prioritizes vulnerability over code: %s', (query: string) => {
    // "CVE" is a vuln word, "python" is a code word.
    // The router checks VULN_RE before CODE_HARD_RE or LANG_TOKEN_RE.
    expect(classifyIntentDetailed(query).vertical).toBe('vulnerabilities');
  });
});
