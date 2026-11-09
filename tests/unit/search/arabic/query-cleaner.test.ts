import { describe, it, expect } from 'vitest';
import {
  cleanQueryForSearch,
  isArabicQuery,
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

  it('trims function words at the EDGES of the subject', () => {
    const out = cleanQueryForSearch('في مصر القديمة');
    expect(out.searchQuery).toBe('مصر القديمة');
  });

  it('keeps function words INSIDE the subject (they carry the relation)', () => {
    // Regression: removing the interior "في" turned a natural phrase into a
    // word salad ("مباراة مصر كأس العالم").
    const out = cleanQueryForSearch('مباراة مصر في كأس العالم');
    expect(out.searchQuery).toBe('مباراة مصر في كأس العالم');
  });

  it('never removes a temporal qualifier that flips the meaning', () => {
    // "قبل" and "بعد" are opposites: merging them makes the dispatch de-dup
    // collapse two different questions into one.
    const before = cleanQueryForSearch('مصر قبل الثورة');
    const after = cleanQueryForSearch('مصر بعد الثورة');
    expect(before.searchQuery).toBe('مصر قبل الثورة');
    expect(after.searchQuery).toBe('مصر بعد الثورة');
    expect(before.searchQuery).not.toBe(after.searchQuery);
  });

  it('does not strip a trailing given name', () => {
    // "علي" is the name Ali — the trailing scan must not eat it.
    expect(cleanQueryForSearch('مسجد محمد علي').searchQuery).toBe('مسجد محمد علي');
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
    // "من الفراعنة إلى اليوم" is part of the subject, not trailing question
    // scaffolding — the cleaner must not cut at "من" and must not delete the
    // interior prepositions either.
    const out = cleanQueryForSearch('تاريخ مصر من الفراعنة إلى اليوم');
    expect(out.searchQuery).toBe('تاريخ مصر من الفراعنة إلى اليوم');
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
