import { describe, it, expect } from 'vitest';
import { getAgentDefaultMaxPages } from '../../../src/agent/pipeline.js';

// agent default max_pages should be 3 to keep response within token caps.
// A higher default fetches too many pages and blows the budget on long runs.
describe('agent pipeline — H3 default max_pages', () => {
  it('exports a tight default max_pages = 3', () => {
    expect(getAgentDefaultMaxPages()).toBe(3);
  });
});
