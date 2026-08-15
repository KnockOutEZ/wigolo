import { describe, it, expect } from 'vitest';
import {
  computeIncludeDomainAttrition,
  mergeDomainAttrition,
  describeDomainFilterCause,
} from '../../../src/search/core/domain-filter-cause.js';

function r(url: string) {
  return { url };
}

describe('include-domain attrition accounting', () => {
  it('counts every result the include predicate rejected', () => {
    const att = computeIncludeDomainAttrition(
      [r('https://a.test/1'), r('https://b.test/2'), r('https://c.test/3')],
      ['example.com'],
    );
    expect(att).toEqual({
      include_domains: ['example.com'],
      candidates: 3,
      matched: 0,
      dropped: 3,
    });
  });

  // The attribution predicate MUST be the same one the filter enforces.
  // A subdomain is kept by applyDomainFilters, so it must count as matched
  // here — otherwise the notice would blame the filter for a result the
  // filter actually let through.
  it('treats a subdomain as matched, mirroring the hard whitelist', () => {
    const att = computeIncludeDomainAttrition(
      [r('https://docs.foo.com/x'), r('https://foo.com/y'), r('https://bar.com/z')],
      ['foo.com'],
    );
    expect(att?.matched).toBe(2);
    expect(att?.dropped).toBe(1);
  });

  // applyDomainFilters drops a result whose URL yields no hostname. If we
  // counted it as matched the arithmetic would claim survivors that the
  // response does not contain.
  it('counts an unparseable URL as dropped, mirroring the filter', () => {
    const att = computeIncludeDomainAttrition([r('not a url')], ['foo.com']);
    expect(att?.matched).toBe(0);
    expect(att?.dropped).toBe(1);
  });

  it('reports nothing when the caller set no include_domains', () => {
    expect(computeIncludeDomainAttrition([r('https://a.test/1')], undefined)).toBeUndefined();
    expect(computeIncludeDomainAttrition([r('https://a.test/1')], [])).toBeUndefined();
  });

  it('sums candidates across dispatch waves and unions the requested domains', () => {
    const merged = mergeDomainAttrition(
      { include_domains: ['foo.com'], candidates: 10, matched: 0, dropped: 10 },
      { include_domains: ['bar.com'], candidates: 8, matched: 0, dropped: 8 },
    );
    expect(merged).toEqual({
      include_domains: ['foo.com', 'bar.com'],
      candidates: 18,
      matched: 0,
      dropped: 18,
    });
  });
});

describe('filter-induced zero-result cause', () => {
  it('names the filter when engines produced results and none survived scoping', () => {
    const notice = describeDomainFilterCause({
      include_domains: ['example.com'],
      candidates: 18,
      matched: 0,
      dropped: 18,
    });
    expect(notice).toBeTruthy();
    // Actionable: the caller must be able to see WHICH scope was applied and
    // HOW MUCH existed before it, so "widen the scope" is an obvious next step.
    expect(notice).toContain('example.com');
    expect(notice).toContain('18');
    expect(notice).toContain('include_domains');
  });

  // NEGATIVE — the whole point of the slice. When no engine returned anything
  // there is nothing for the filter to have eaten, so blaming the filter would
  // send the caller to widen a scope that was never the problem.
  it('stays silent when there were no candidates to filter', () => {
    expect(
      describeDomainFilterCause({
        include_domains: ['example.com'],
        candidates: 0,
        matched: 0,
        dropped: 0,
      }),
    ).toBeUndefined();
  });

  // NEGATIVE — partial attrition is the filter working as designed. Any
  // survivor means something else emptied the response downstream (freshness
  // window, exact-phrase, relevance floor), and the filter must not take blame.
  it('stays silent when the filter left at least one survivor', () => {
    expect(
      describeDomainFilterCause({
        include_domains: ['example.com'],
        candidates: 18,
        matched: 3,
        dropped: 15,
      }),
    ).toBeUndefined();
  });

  it('stays silent when no attrition was recorded at all', () => {
    expect(describeDomainFilterCause(undefined)).toBeUndefined();
  });
});
