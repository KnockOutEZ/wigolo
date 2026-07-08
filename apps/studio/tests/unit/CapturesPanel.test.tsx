import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CapturesPanel } from '../../src/renderer/CapturesPanel';
import type { CaptureDto } from '../../src/shared/ipc';

describe('CapturesPanel', () => {
  it('renders an extraction (grab-all) artifact with its host-derived counts + provenance', () => {
    const caps: CaptureDto[] = [
      { id: 1, type: 'extraction', title: '3 rows · 2 columns', url: 'https://shop.test/plans', trusted: false, createdAt: '2026-07-09T00:00:00Z' },
    ];
    const html = renderToStaticMarkup(<CapturesPanel captures={caps} />);
    expect(html).toContain('caps__item--extraction');
    expect(html).toContain('grab-all');            // extraction shows as a "grab-all" badge
    expect(html).toContain('3 rows · 2 columns');   // host-derived counts
    expect(html).toContain('https://shop.test/plans'); // provenance
  });

  it('renders a normal clip without the extraction modifier', () => {
    const caps: CaptureDto[] = [{ id: 2, type: 'clip', title: 'A doc', url: 'https://x.test', trusted: false, createdAt: '2026-07-09T00:00:00Z' }];
    const html = renderToStaticMarkup(<CapturesPanel captures={caps} />);
    expect(html).not.toContain('caps__item--extraction');
    expect(html).toContain('A doc');
  });

  it('shows the empty state with no captures', () => {
    const html = renderToStaticMarkup(<CapturesPanel captures={[]} />);
    expect(html.toLowerCase()).toContain('nothing captured yet');
  });

  it('renders the "Synthesize session" foot button only when onSynthesize is wired (P6 F3)', () => {
    const caps: CaptureDto[] = [{ id: 1, type: 'clip', title: 'A', url: 'https://x.test', trusted: false, createdAt: '2026-07-09T00:00:00Z' }];
    expect(renderToStaticMarkup(<CapturesPanel captures={caps} />)).not.toContain('Synthesize session');
    const withBtn = renderToStaticMarkup(<CapturesPanel captures={caps} onSynthesize={() => {}} />);
    expect(withBtn).toContain('Synthesize session');
  });

  it('shows the synthesizing state + renders the returned brief', () => {
    const caps: CaptureDto[] = [{ id: 1, type: 'clip', title: 'A', url: 'https://x.test', trusted: false, createdAt: '2026-07-09T00:00:00Z' }];
    const busy = renderToStaticMarkup(<CapturesPanel captures={caps} onSynthesize={() => {}} synthesizing />);
    expect(busy).toContain('Synthesizing…');
    const withBrief = renderToStaticMarkup(
      <CapturesPanel captures={caps} onSynthesize={() => {}} brief={{ empty: true }} />,
    );
    expect(withBrief.toLowerCase()).toContain('nothing to synthesize yet');
  });
});
