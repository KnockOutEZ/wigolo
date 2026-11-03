import { describe, it, expect } from 'vitest';
import {
  cleanQueryForSearch,
  isArabicQuery,
  normalizeArabic,
} from '../../../../src/search/arabic/query-cleaner.js';
import { preprocessQueryForSearch } from '../../../../src/search/query.js';

// WHY these tests exist
// An Arabic question is mostly scaffolding: "من هي X وماذا تعرف عنها؟"
// sends the leading preposition "من" to the engines, which match articles
// about the LETTER "من" and push the real answer down. The cleaner strips
// the scaffolding before the query reaches an engine — and must never send
// an empty or over-stripped query.

describe('isArabicQuery', () => {
  it('detects Arabic text', () => {
    expect(isArabicQuery('من هو بطل الحرب والسلام؟')).toBe(true);
    expect(isArabicQuery('سيدة الشاشة العربية')).toBe(true);
  });

  it('does not treat Latin or numeric text as Arabic', () => {
    expect(isArabicQuery('machine learning papers 2024')).toBe(false);
    expect(isArabicQuery('12345')).toBe(false);
    expect(isArabicQuery('')).toBe(false);
  });

  it('treats a mixed query as Arabic only when Arabic dominates', () => {
    expect(isArabicQuery('Pokémon من')).toBe(false);
    expect(isArabicQuery('Who is بطل，经营')).toBe(false);
    expect(isArabicQuery('من هو بطل、经营؟')).toBe(true);
  });
});

describe('normalizeArabic', () => {
  it('strips diacritics and folds letter variants', () => {
    expect(normalizeArabic('مُحَمَّد')).toBe('محمد');
    expect(normalizeArabic('أحمد')).toBe('احمد');
    expect(normalizeArabic('مدرسة')).toBe('مدرسه');
  });
});

describe('cleanQueryForSearch', () => {
  it('strips the leading question scaffolding', () => {
    const out = cleanQueryForSearch('من هو مؤسس الجيش المصري الحديث');
    expect(out.searchQuery).toBe('مؤسس الجيش المصري الحديث');
    expect(out.subject).toBe('مؤسس الجيش المصري الحديث');
    expect(out.changed).toBe(true);
  });

  it('strips the trailing scaffolding', () => {
    const out = cleanQueryForSearch('من هي ذات النطاقين وماذا تعرف عنها؟');
    expect(out.searchQuery).toBe('ذات النطاقين');
    expect(out.subject).toBe('ذات النطاقين');
  });

  it('strips a polite opener', () => {
    expect(cleanQueryForSearch('من فضلك من هو طه حسين').searchQuery).toBe('طه حسين');
  });

  it('removes Arabic function words from the body', () => {
    const out = cleanQueryForSearch('مباراة مصر في كأس العالم');
    expect(out.searchQuery).not.toContain('في');
    expect(out.searchQuery).toContain('مباراة');
    expect(out.searchQuery).toContain('مصر');
  });

  it('leaves an already-clean query untouched', () => {
    const out = cleanQueryForSearch('محمد علي باشا');
    expect(out.searchQuery).toBe('محمد علي باشا');
    expect(out.changed).toBe(false);
  });

  it('never returns an empty query', () => {
    for (const q of ['من', 'من هو', 'ما', '؟', 'من هو؟']) {
      const out = cleanQueryForSearch(q);
      expect(out.searchQuery.length).toBeGreaterThan(0);
    }
  });

  it('never over-strips a short but meaningful query', () => {
    const out = cleanQueryForSearch('من هو زيد');
    expect(out.searchQuery.length).toBeGreaterThan(0);
  });

  it('keeps a subject that CONTAINS a scaffolding word mid-sentence', () => {
    // "من الفراعنة" is part of the subject, not trailing question
    // scaffolding — the cleaner must not cut the query at the first "من".
    const out = cleanQueryForSearch('تاريخ مصر من الفراعنة إلى اليوم');
    expect(out.searchQuery).toContain('الفراعنة');
    expect(out.searchQuery).toContain('اليوم');
  });

  it('matches vocalized (harakat-carrying) question prefixes', () => {
    const out = cleanQueryForSearch('مَنْ هِيَ ذات النطاقين وماذا تعرف عنها؟');
    expect(out.searchQuery).toBe('ذات النطاقين');
  });
});

describe('preprocessQueryForSearch', () => {
  it('normalizes Arabic queries', () => {
    const out = preprocessQueryForSearch('من هي ذات النطاقين وماذا تعرف عنها؟');
    expect(out.isArabic).toBe(true);
    expect(out.searchQuery).toBe('ذات النطاقين');
    expect(out.subject).toBe('ذات النطاقين');
    expect(out.changed).toBe(true);
  });

  it('is a no-op for non-Arabic queries', () => {
    const q = 'machine learning papers 2024';
    const out = preprocessQueryForSearch(q);
    expect(out.isArabic).toBe(false);
    expect(out.searchQuery).toBe(q);
    expect(out.subject).toBe(q);
    expect(out.changed).toBe(false);
  });
});
