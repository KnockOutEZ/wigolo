import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GrantCard } from '../../src/renderer/GrantCard';

describe('GrantCard', () => {
  it('offers a scoped one-click grant when not yet granted', () => {
    const html = renderToStaticMarkup(<GrantCard granted={false} onGrant={() => {}} onRevoke={() => {}} />).toLowerCase();
    expect(html).toContain('localhost');
    expect(html).toContain('this session'); // scoping copy
    expect(html).toContain('allow');
  });
  it('shows a granted/revoke state once granted', () => {
    const html = renderToStaticMarkup(<GrantCard granted onGrant={() => {}} onRevoke={() => {}} />).toLowerCase();
    expect(html).toContain('revoke');
  });
  it('reassures that cloud-internal stays blocked (capability language, no engine names)', () => {
    const html = renderToStaticMarkup(<GrantCard granted={false} onGrant={() => {}} onRevoke={() => {}} />).toLowerCase();
    expect(html).toContain('cloud');
    for (const banned of ['electron', 'cdp', 'playwright', 'chromium']) expect(html).not.toContain(banned);
  });
});
