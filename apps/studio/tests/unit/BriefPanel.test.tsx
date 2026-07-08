import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefPanel } from '../../src/renderer/BriefPanel';
import type { ResearchBriefDto } from 'wigolo/studio';

const brief = (over: Record<string, unknown> = {}): ResearchBriefDto => ({
  brief: {
    topics: ['pricing'],
    highlights: [],
    key_findings: ['Pro tier is $20/mo', 'Free tier has no API'],
    key_finding_sources: [0, 1],
    per_source_char_cap: 3000,
    total_sources_char_cap: 40000,
    sections: { overview: { key_findings: [], cross_references: [] }, gaps: ['no enterprise pricing found'] },
    query_type: 'general',
    ...over,
  },
  provenance: [
    { artifactId: 10, url: 'https://ex.com/a', title: 'Plans A', ts: '2026-07-09T00:00:00Z' },
    { artifactId: 20, url: 'https://ex.com/b', title: 'Plans B', ts: '2026-07-09T00:01:00Z' },
  ],
});

describe('BriefPanel', () => {
  it('renders topics, cited key findings, and a provenance chip per finding', () => {
    const html = renderToStaticMarkup(<BriefPanel result={brief()} />);
    expect(html).toContain('pricing');
    expect(html).toContain('Pro tier is $20/mo');
    expect(html).toContain('Plans A');           // provenance chip → the capturing artifact
    expect(html).toContain('https://ex.com/b');
    expect(html).toContain('no enterprise pricing found'); // gaps
  });

  it('fails open per-bullet when a finding source index is out of range (no chip, no crash)', () => {
    const b = brief({ key_findings: ['orphan finding'], key_finding_sources: [99] });
    const html = renderToStaticMarkup(<BriefPanel result={b} />);
    expect(html).toContain('orphan finding');
    expect(html).not.toContain('brief__chip'); // index 99 → provenance[99] undefined → no chip rendered
  });

  it('renders an honest empty state (never a fabricated brief)', () => {
    const html = renderToStaticMarkup(<BriefPanel result={{ empty: true }} />);
    expect(html.toLowerCase()).toContain('nothing to synthesize yet');
  });

  it('renders nothing before a synthesis has run (null)', () => {
    expect(renderToStaticMarkup(<BriefPanel result={null} />)).toBe('');
  });
});
