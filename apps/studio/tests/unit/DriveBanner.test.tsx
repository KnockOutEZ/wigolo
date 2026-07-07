import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DriveBanner } from '../../src/renderer/DriveBanner';

describe('DriveBanner', () => {
  it('renders nothing when the human holds (show=false)', () => {
    expect(renderToStaticMarkup(<DriveBanner show={false} step="anything" onPause={() => {}} />)).toBe('');
  });
  it('names the current step, offers Pause, and reminds the human they can take over', () => {
    const html = renderToStaticMarkup(<DriveBanner show step="opening FAQ" onPause={() => {}} />);
    expect(html).toContain('opening FAQ');
    expect(html.toLowerCase()).toContain('take over');
    expect(html).toContain('Pause');
  });
  it('falls back to a generic driving message when there is no step yet', () => {
    const html = renderToStaticMarkup(<DriveBanner show step="" onPause={() => {}} />);
    expect(html.toLowerCase()).toContain('driving');
  });
});
