import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TabStrip, groupTabsByRun } from '../../src/renderer/TabStrip';
import type { TabInfo } from '../../src/shared/ipc';

const tabs: TabInfo[] = [{ id: 't1', url: 'https://example.com', title: 'Example', active: true }];

const tab = (id: string, runId?: string): TabInfo =>
  ({ id, url: `https://example.com/${id}`, title: id, active: false, ...(runId ? { runId } : {}) });

describe('TabStrip provenance dots', () => {
  it('renders a violet agent dot when provenance is agent', () => {
    const html = renderToStaticMarkup(<TabStrip tabs={tabs} onFocus={() => {}} onClose={() => {}} onNew={() => {}} provenance={() => 'agent'} />);
    expect(html).toContain('tab__dot--agent');
    expect(html).not.toContain('tab__fav');
  });
  it('renders an amber working dot when provenance is working', () => {
    const html = renderToStaticMarkup(<TabStrip tabs={tabs} onFocus={() => {}} onClose={() => {}} onNew={() => {}} provenance={() => 'working'} />);
    expect(html).toContain('tab__dot--working');
  });
  it('renders a green human dot when provenance is human', () => {
    const html = renderToStaticMarkup(<TabStrip tabs={tabs} onFocus={() => {}} onClose={() => {}} onNew={() => {}} provenance={() => 'human'} />);
    expect(html).toContain('tab__dot--human');
  });
  it('falls back to the favicon chip when provenance is none (or absent)', () => {
    const html = renderToStaticMarkup(<TabStrip tabs={tabs} onFocus={() => {}} onClose={() => {}} onNew={() => {}} provenance={() => 'none'} />);
    expect(html).toContain('tab__fav');
    expect(html).not.toContain('tab__dot--');
    const noProp = renderToStaticMarkup(<TabStrip tabs={tabs} onFocus={() => {}} onClose={() => {}} onNew={() => {}} />);
    expect(noProp).toContain('tab__fav');
  });
});

describe('groupTabsByRun', () => {
  it('gathers a run\'s tabs into ONE group even when the tab layer interleaves them', () => {
    // The tab layer orders by creation, so two runs opening tabs in turn arrive interleaved. A group
    // that split here would label a boundary the eye cannot see.
    const groups = groupTabsByRun([tab('a', 'qy4q'), tab('b', 'cnpy'), tab('c', 'qy4q')]);
    expect(groups.map((g) => g.runId)).toEqual(['qy4q', 'cnpy']);
    expect(groups[0].tabs.map((t) => t.id)).toEqual(['a', 'c']);
    expect(groups[1].tabs.map((t) => t.id)).toEqual(['b']);
  });

  it('orders groups by where their first tab appears, not by run id', () => {
    // 'zz' sorts last and appears first; an implementation that sorted would reorder the strip under
    // the human every time a run was created.
    expect(groupTabsByRun([tab('a', 'zz'), tab('b', 'aa')]).map((g) => g.runId)).toEqual(['zz', 'aa']);
  });

  it('collects every unowned tab into a single null group — the human\'s, by absence', () => {
    const groups = groupTabsByRun([tab('h1'), tab('a', 'qy4q'), tab('h2')]);
    expect(groups.map((g) => g.runId)).toEqual([null, 'qy4q']);
    expect(groups[0].tabs.map((t) => t.id)).toEqual(['h1', 'h2']);
  });

  it('returns no groups for an empty strip', () => {
    expect(groupTabsByRun([])).toEqual([]);
  });
});

describe('TabStrip run id in the window chrome', () => {
  it('labels every promoted run\'s group with its short id, focused or not', () => {
    const html = renderToStaticMarkup(
      <TabStrip
        tabs={[tab('a', 'qy4q'), tab('b', 'cnpy')]}
        onFocus={() => {}} onClose={() => {}} onNew={() => {}}
        focusedRunId="qy4q"
      />,
    );
    // Both ids render — the acceptance is "every promoted run", not "the one you are looking at".
    expect(html).toContain('data-testid="run-id-qy4q"');
    expect(html).toContain('data-testid="run-id-cnpy"');
    expect(html).toContain('>qy4q</span>');
    expect(html).toContain('>cnpy</span>');
  });

  it('marks only the focused run\'s group as focused', () => {
    const html = renderToStaticMarkup(
      <TabStrip
        tabs={[tab('a', 'qy4q'), tab('b', 'cnpy')]}
        onFocus={() => {}} onClose={() => {}} onNew={() => {}}
        focusedRunId="cnpy"
      />,
    );
    expect(html).toMatch(/class="tab-group tab-group--focused" data-testid="run-group-cnpy"/);
    expect(html).toMatch(/class="tab-group" data-testid="run-group-qy4q"/);
  });

  it('gives the human\'s own group no id and no run — a label there would invent one', () => {
    const html = renderToStaticMarkup(
      <TabStrip tabs={[tab('h1')]} onFocus={() => {}} onClose={() => {}} onNew={() => {}} focusedRunId={null} />,
    );
    expect(html).toContain('data-testid="run-group-human"');
    expect(html).not.toContain('tab-group__id');
    expect(html).not.toContain('tab-group--focused');
  });

  it('renders the id verbatim — no truncation, no case change, no decoration', () => {
    // The whole point is byte-identity with the id REST returns. Any prettifying here breaks law 8's
    // shared address space silently, because both strings still LOOK like a run id.
    const html = renderToStaticMarkup(
      <TabStrip tabs={[tab('a', 'q7f2mn93')]} onFocus={() => {}} onClose={() => {}} onNew={() => {}} focusedRunId="q7f2mn93" />,
    );
    expect(html).toContain('>q7f2mn93</span>');
  });

  it('keeps the strip usable with no tabs at all', () => {
    const html = renderToStaticMarkup(<TabStrip tabs={[]} onFocus={() => {}} onClose={() => {}} onNew={() => {}} />);
    expect(html).toContain('data-testid="new-tab"');
    expect(html).not.toContain('tab-group__id');
  });
});
