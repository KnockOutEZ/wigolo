import { describe, it, expect } from 'vitest';
import { classifyIntentDetailed } from '../../../../src/search/core/intent-router.js';

describe('intent-router — vulnerabilities', () => {
  it('routes explicit CVE IDs to vulnerabilities', () => {
    expect(classifyIntentDetailed('CVE-2024-12345').vertical).toBe('vulnerabilities');
    expect(classifyIntentDetailed('cve-2023-999').vertical).toBe('vulnerabilities');
    expect(classifyIntentDetailed('GHSA-abcd-1234-efgh').vertical).toBe('vulnerabilities');
  });

  it('routes vulnerability keywords to vulnerabilities', () => {
    expect(classifyIntentDetailed('log4j vulnerability').vertical).toBe('vulnerabilities');
    expect(classifyIntentDetailed('NVD advisory apache').vertical).toBe('vulnerabilities');
    expect(classifyIntentDetailed('recent exploit in openssl').vertical).toBe('vulnerabilities');
    expect(classifyIntentDetailed('microsoft patch tuesday').vertical).toBe('vulnerabilities');
    expect(classifyIntentDetailed('what is cwe-79').vertical).toBe('vulnerabilities');
  });

  it('does not over-trigger on general security terms', () => {
    expect(classifyIntentDetailed('python security best practices').vertical).toBe('general');
    // It's possible that "python security best practices" falls back to general, 
    // unless there is a specific date or code trigger.
  });

  it('allows overriding via hint', () => {
    expect(classifyIntentDetailed('some completely unrelated query', { hint: 'vulnerabilities' }).vertical).toBe('vulnerabilities');
  });
  
  it('routes embedded GHSA ID to vulnerabilities', () => {
    expect(classifyIntentDetailed('explain GHSA-abcd-1234-efgh').vertical).toBe('vulnerabilities');
    expect(classifyIntentDetailed('GHSA-abcd-1234-efgh details').vertical).toBe('vulnerabilities');
  });

  it('routes embedded CVE ID to vulnerabilities', () => {
    expect(classifyIntentDetailed('fix CVE-2024-1234 in python').vertical).toBe('vulnerabilities');
    expect(classifyIntentDetailed('CVE-2024-1234 details').vertical).toBe('vulnerabilities');
  });

  it('prioritizes vulnerability over code for CVE + python', () => {
    // "CVE" is a vuln word, "python" is a code word. 
    // The router checks VULN_RE before CODE_HARD_RE or LANG_TOKEN_RE.
    expect(classifyIntentDetailed('CVE-2024-1234 python').vertical).toBe('vulnerabilities');
    expect(classifyIntentDetailed('fix python CVE-2024-1234').vertical).toBe('vulnerabilities');
  });
});
