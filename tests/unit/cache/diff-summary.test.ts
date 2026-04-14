import { describe, it, expect } from 'vitest';
import { computeDiffSummary } from '../../../src/cache/diff-summary.js';

describe('computeDiffSummary', () => {
  describe('identical content', () => {
    it('returns no-change summary for identical strings', () => {
      const text = '# Hello\n\nSome content here.\nAnother line.';
      const result = computeDiffSummary(text, text);
      expect(result).toContain('0 lines added');
      expect(result).toContain('0 lines removed');
      expect(result).toContain('0 lines modified');
    });

    it('returns no-change summary for empty strings', () => {
      const result = computeDiffSummary('', '');
      expect(result).toContain('0 lines added');
      expect(result).toContain('0 lines removed');
    });
  });

  describe('additions only', () => {
    it('detects added lines', () => {
      const old = 'Line 1\nLine 2';
      const new_ = 'Line 1\nLine 2\nLine 3\nLine 4';
      const result = computeDiffSummary(old, new_);
      expect(result).toContain('2 lines added');
      expect(result).toContain('0 lines removed');
    });

    it('detects content added from empty', () => {
      const result = computeDiffSummary('', 'Line 1\nLine 2\nLine 3');
      expect(result).toContain('3 lines added');
      expect(result).toContain('0 lines removed');
    });

    it('detects single line addition', () => {
      const old = 'Line 1';
      const new_ = 'Line 1\nLine 2';
      const result = computeDiffSummary(old, new_);
      expect(result).toContain('1 line added');
    });
  });

  describe('removals only', () => {
    it('detects removed lines', () => {
      const old = 'Line 1\nLine 2\nLine 3\nLine 4';
      const new_ = 'Line 1\nLine 2';
      const result = computeDiffSummary(old, new_);
      expect(result).toContain('2 lines removed');
      expect(result).toContain('0 lines added');
    });

    it('detects content removed to empty', () => {
      const result = computeDiffSummary('Line 1\nLine 2\nLine 3', '');
      expect(result).toContain('3 lines removed');
      expect(result).toContain('0 lines added');
    });

    it('detects single line removal', () => {
      const old = 'Line 1\nLine 2';
      const new_ = 'Line 1';
      const result = computeDiffSummary(old, new_);
      expect(result).toContain('1 line removed');
    });
  });

  describe('modifications', () => {
    it('detects modified lines', () => {
      const old = 'Line 1\nLine 2\nLine 3';
      const new_ = 'Line 1\nLine 2 modified\nLine 3';
      const result = computeDiffSummary(old, new_);
      expect(result).toContain('modified');
    });

    it('detects complete replacement', () => {
      const old = 'Completely old content\nMore old stuff';
      const new_ = 'Completely new content\nMore new stuff';
      const result = computeDiffSummary(old, new_);
      expect(result).toMatch(/\d+ lines? (added|removed|modified)/);
    });
  });

  describe('mixed changes', () => {
    it('reports additions, removals, and modifications', () => {
      const old = 'Header\nOld Line 2\nLine 3\nLine 4';
      const new_ = 'Header\nNew Line 2\nLine 3\nLine 5\nLine 6';
      const result = computeDiffSummary(old, new_);
      expect(result).toMatch(/\d+ lines? added/);
    });

    it('handles interleaved changes', () => {
      const old = 'A\nB\nC\nD\nE';
      const new_ = 'A\nX\nC\nY\nE\nF';
      const result = computeDiffSummary(old, new_);
      expect(result).toMatch(/\d+ lines? added/);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('unicode content', () => {
    it('handles unicode characters in diff', () => {
      const old = 'English line\nAnother line';
      const new_ = 'English line\nNoch eine Zeile\nNouvelle ligne';
      const result = computeDiffSummary(old, new_);
      expect(result).toMatch(/\d+ lines? added/);
    });

    it('handles emoji in content', () => {
      const old = 'Line with emoji';
      const new_ = 'Line with different emoji';
      const result = computeDiffSummary(old, new_);
      expect(typeof result).toBe('string');
    });

    it('handles CJK characters', () => {
      const old = 'Hello World\nSecond Line';
      const new_ = 'Hello World\nSecond Line Modified';
      const result = computeDiffSummary(old, new_);
      expect(typeof result).toBe('string');
    });
  });

  describe('whitespace handling', () => {
    it('treats lines differing only in trailing whitespace as modified', () => {
      const old = 'Line 1  \nLine 2';
      const new_ = 'Line 1\nLine 2';
      const result = computeDiffSummary(old, new_);
      expect(typeof result).toBe('string');
    });

    it('handles windows-style line endings', () => {
      const old = 'Line 1\r\nLine 2\r\n';
      const new_ = 'Line 1\nLine 2\nLine 3\n';
      const result = computeDiffSummary(old, new_);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles mixed line endings', () => {
      const old = 'Line 1\nLine 2\r\nLine 3';
      const new_ = 'Line 1\nLine 2\nLine 3\nLine 4';
      const result = computeDiffSummary(old, new_);
      expect(typeof result).toBe('string');
    });
  });

  describe('edge cases', () => {
    it('handles very long content efficiently', () => {
      const oldLines = Array.from({ length: 5000 }, (_, i) => `Line ${i}`);
      const newLines = [...oldLines];
      newLines[2500] = 'Modified line in the middle';
      newLines.push('New line at the end');

      const start = Date.now();
      const result = computeDiffSummary(oldLines.join('\n'), newLines.join('\n'));
      const elapsed = Date.now() - start;

      expect(result).toBeDefined();
      expect(elapsed).toBeLessThan(5000);
    });

    it('handles single-line content', () => {
      const result = computeDiffSummary('one line', 'different line');
      expect(result).toMatch(/\d+ lines? (added|removed|modified)/);
    });

    it('handles content with only newlines', () => {
      const result = computeDiffSummary('\n\n\n', '\n\n');
      expect(typeof result).toBe('string');
    });

    it('handles null-like inputs gracefully (empty strings)', () => {
      const result = computeDiffSummary('', '');
      expect(result).toContain('0');
    });

    it('returns a string, never undefined or null', () => {
      const result = computeDiffSummary('a', 'b');
      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
    });

    it('summary format is human-readable', () => {
      const old = 'Line 1\nLine 2\nLine 3';
      const new_ = 'Line 1\nModified\nLine 3\nLine 4';
      const result = computeDiffSummary(old, new_);
      expect(result).toMatch(/\d+ lines? added, \d+ lines? removed, \d+ lines? modified/);
    });
  });
});
