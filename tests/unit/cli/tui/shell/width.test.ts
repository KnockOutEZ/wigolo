import { describe, it, expect } from 'vitest';
import { classifyWidth } from '../../../../../src/cli/tui/shell/width.js';

describe('width', () => {
  it('classifies wide for ≥90', () => expect(classifyWidth(120)).toBe('wide'));
  it('classifies narrow for 60–89', () => expect(classifyWidth(80)).toBe('narrow'));
  it('classifies tiny for <60', () => expect(classifyWidth(50)).toBe('tiny'));

  // Boundary cases: verify the exact cutoff values
  it('classifies 90 as wide (lower bound)', () => expect(classifyWidth(90)).toBe('wide'));
  it('classifies 89 as narrow (upper bound)', () => expect(classifyWidth(89)).toBe('narrow'));
  it('classifies 60 as narrow (lower bound)', () => expect(classifyWidth(60)).toBe('narrow'));
  it('classifies 59 as tiny (upper bound)', () => expect(classifyWidth(59)).toBe('tiny'));
});
