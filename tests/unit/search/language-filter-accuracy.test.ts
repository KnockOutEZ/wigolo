/**
 * The language filter stopped running a 12 MB n-gram language model (tinyld) and
 * became Unicode script detection.
 *
 * That is an accuracy claim, so it gets measured rather than asserted. This file
 * runs the OLD decision function and the NEW one side by side over the same
 * corpus and pins what actually changed — a test that only exercised the new code
 * could happily encode a false belief about the old one.
 *
 * tinyld is kept as a devDependency for exactly this comparison and is not
 * imported anywhere in src/.
 */
import { describe, it, expect } from 'vitest';
import { detectAll } from 'tinyld';
import { detectScript, filterByLanguage } from '../../../src/search/language-filter.js';

// --- the OLD implementation, verbatim, as the reference ---------------------
const LATIN_LANGS = new Set([
  'en', 'es', 'fr', 'pt', 'de', 'it', 'nl', 'da', 'sv', 'no', 'fi', 'is',
  'pl', 'cs', 'sk', 'hu', 'ro', 'hr', 'sl', 'lt', 'lv', 'et', 'tr', 'vi',
  'id', 'ms', 'tl', 'sw', 'af', 'ca', 'gl', 'eu', 'ga', 'cy', 'mt', 'sq',
  'lb', 'fo', 'ber', 'so', 'ha', 'yo', 'ig', 'zu', 'xh', 'st', 'tn',
]);

function detectLangOld(text: string): string {
  const t = text?.trim() ?? '';
  if (t.length < 12) return 'und';
  try {
    const ranked = detectAll(t);
    const top = ranked[0];
    if (!top || top.accuracy < 0.1) return 'und';
    return top.lang || 'und';
  } catch {
    return 'und';
  }
}

function isMismatchOld(lang: string, target: string): boolean {
  if (lang === target || lang === 'und') return false;
  if (LATIN_LANGS.has(target) && LATIN_LANGS.has(lang)) return false;
  return true;
}

/**
 * Drive the REAL filter rather than re-deriving its rule here. A test-local
 * reimplementation drifts from the code it claims to measure, which is how a
 * differential ends up comparing two of its own opinions.
 *
 * dropThreshold 1.0 disables the batch-drop stage, isolating the per-result
 * language decision.
 */
function isMismatchNew(text: string, target: string): boolean {
  const out = filterByLanguage(
    [{ url: 'https://example.com/x', title: text, snippet: '', engine: 'bing' }],
    { target, dropThreshold: 1.0 },
  );
  return out.discarded.some((d) => d.reason === 'language_mismatch');
}

const NON_LATIN_TARGETS = ['ru', 'uk', 'zh', 'ja', 'ko', 'ar', 'he', 'el', 'hi', 'th'];

// --- corpus: realistic result title + snippet text, one per language --------
const CORPUS: Record<string, string[]> = {
  en: [
    'Local-first web search for AI agents — how the fetch router escalates to a browser',
    'Getting started with the API: authentication, rate limits and pagination explained',
  ],
  de: [
    'Lokale Websuche für KI-Agenten — wie der Abruf-Router zum Browser eskaliert',
    'Erste Schritte mit der API: Authentifizierung, Ratenbegrenzung und Paginierung',
  ],
  fr: [
    'Recherche web locale pour les agents IA — comment le routeur bascule vers un navigateur',
    'Premiers pas avec l API : authentification, limites de débit et pagination expliquées',
  ],
  es: [
    'Búsqueda web local para agentes de IA — cómo el enrutador escala a un navegador',
    'Primeros pasos con la API: autenticación, límites de tasa y paginación explicados',
  ],
  pt: ['Pesquisa web local para agentes de IA e como o roteador escala para um navegador'],
  it: ['Ricerca web locale per agenti IA e come il router passa a un browser reale'],
  nl: ['Lokaal zoeken op het web voor AI-agenten en hoe de router naar een browser gaat'],
  pl: ['Lokalne wyszukiwanie internetowe dla agentów AI i jak router przechodzi do przeglądarki'],
  tr: ['Yapay zeka ajanları için yerel web araması ve yönlendiricinin tarayıcıya geçişi'],
  vi: ['Tìm kiếm web cục bộ cho tác nhân AI và cách bộ định tuyến chuyển sang trình duyệt'],
  id: ['Pencarian web lokal untuk agen AI dan bagaimana router beralih ke peramban'],
  ru: [
    'Локальный веб-поиск для ИИ-агентов — как маршрутизатор переключается на браузер',
    'Начало работы с API: аутентификация, ограничения скорости и постраничная навигация',
  ],
  uk: [
    'Локальний веб-пошук для ШІ-агентів — як маршрутизатор перемикається на браузер',
    'Початок роботи з API: автентифікація, обмеження швидкості та посторінкова навігація',
  ],
  bg: ['Локално уеб търсене за ИИ агенти и как маршрутизаторът превключва към браузър'],
  sr: ['Локална веб претрага за вештачку интелигенцију и како рутер прелази на прегледач'],
  el: ['Τοπική αναζήτηση ιστού για πράκτορες τεχνητής νοημοσύνης και ο δρομολογητής'],
  he: ['חיפוש אינטרנט מקומי עבור סוכני בינה מלאכותית וכיצד הנתב עובר לדפדפן'],
  ar: ['البحث المحلي على الويب لوكلاء الذكاء الاصطناعي وكيف ينتقل الموجه إلى المتصفح'],
  fa: ['جستجوی محلی وب برای عوامل هوش مصنوعی و چگونگی انتقال مسیریاب به مرورگر'],
  hi: ['एआई एजेंटों के लिए स्थानीय वेब खोज और राउटर ब्राउज़र पर कैसे स्विच करता है'],
  mr: ['एआय एजंटसाठी स्थानिक वेब शोध आणि राउटर ब्राउझरवर कसा स्विच होतो याबद्दल'],
  zh: [
    '面向人工智能代理的本地优先网络搜索，以及抓取路由器如何升级到浏览器',
    'API 入门：身份验证、速率限制和分页说明的完整技术文档',
  ],
  ja: [
    'AIエージェントのためのローカルファーストウェブ検索とルーターのブラウザ移行',
    'APIの使い方：認証、レート制限、ページネーションの詳細な技術文書です',
  ],
  ko: ['AI 에이전트를 위한 로컬 우선 웹 검색과 라우터가 브라우저로 전환하는 방법'],
  th: ['การค้นหาเว็บในเครื่องสำหรับเอเจนต์ปัญญาประดิษฐ์และการเปลี่ยนไปใช้เบราว์เซอร์'],
  bn: ['এআই এজেন্টদের জন্য স্থানীয় ওয়েব অনুসন্ধান এবং রাউটার কীভাবে ব্রাউজারে স্যুইচ করে'],
  ta: ['செயற்கை நுண்ணறிவு முகவர்களுக்கான உள்ளூர் வலைத் தேடல் மற்றும் உலாவி மாற்றம்'],
};

const LATIN_TARGETS = ['en', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'pl', 'tr', 'vi', 'id'];

interface Diff {
  agree: number;
  total: number;
  newKeepsOldDrops: string[];
  newDropsOldKeeps: string[];
  /** What the model actually said on each "new drops / old kept" disagreement. */
  newDropsOldKeepsVerdict: Array<{ lang: string; oldLang: string }>;
}

function compare(target: string): Diff {
  let agree = 0;
  let total = 0;
  const newKeepsOldDrops: string[] = [];
  const newDropsOldKeeps: string[] = [];
  const newDropsOldKeepsVerdict: Array<{ lang: string; oldLang: string }> = [];
  for (const [lang, texts] of Object.entries(CORPUS)) {
    for (const text of texts) {
      const oldLang = detectLangOld(text);
      const oldDrop = isMismatchOld(oldLang, target);
      const newDrop = isMismatchNew(text, target);
      total += 1;
      if (oldDrop === newDrop) agree += 1;
      else if (oldDrop && !newDrop) newKeepsOldDrops.push(lang);
      else {
        newDropsOldKeeps.push(lang);
        newDropsOldKeepsVerdict.push({ lang, oldLang });
      }
    }
  }
  return { agree, total, newKeepsOldDrops, newDropsOldKeeps, newDropsOldKeepsVerdict };
}

describe('script detection vs the n-gram language model', () => {
  it('agrees with the model on 34 of 35 decisions for every Latin target', () => {
    // This is the default path: the target is `input.language ?? 'en'`. The old
    // code already treated all Latin languages as a match when the target was
    // Latin, so script separation was the only decision it ever made here.
    for (const target of LATIN_TARGETS) {
      const d = compare(target);
      expect(d.agree, `target=${target}`).toBe(34);
      expect(d.total).toBe(35);
      // Never the other direction: the new filter does not start keeping
      // foreign-script results the model correctly dropped.
      expect(d.newKeepsOldDrops, `target=${target}`).toEqual([]);
    }
  });

  it('the single disagreement is the model MISSING a Chinese result, not a regression', () => {
    // tinyld scores '面向人工智能代理的本地优先网络搜索…' as zh with accuracy
    // 0.0625, under the filter's own 0.1 confidence floor, so the old code
    // resolved it to 'und' and KEPT a pure-Chinese result against an English
    // query. Catching that is the entire point of the filter.
    const missed = CORPUS.zh[0];
    expect(detectLangOld(missed)).toBe('und');
    expect(isMismatchOld(detectLangOld(missed), 'en')).toBe(false);
    expect(detectAll(missed)[0].accuracy).toBeLessThan(0.1);

    expect(detectScript(missed)).toBe('han');
    expect(isMismatchNew(missed, 'en')).toBe(true);

    for (const target of LATIN_TARGETS) {
      expect(compare(target).newDropsOldKeeps).toEqual(['zh']);
    }
  });

  it('never drops a result written in the target script', () => {
    // The safety property that matters: a correct-language result must survive.
    // Stated over the corpus directly rather than relative to the old model, so
    // it cannot inherit the old model's confidence-floor blind spot.
    const sameScript: Record<string, string[]> = {
      en: LATIN_TARGETS, ru: ['ru', 'uk', 'bg', 'sr'], uk: ['ru', 'uk', 'bg', 'sr'],
      zh: ['zh', 'ja'], ja: ['zh', 'ja'], ko: ['ko'], ar: ['ar', 'fa'],
      he: ['he'], el: ['el'], hi: ['hi', 'mr'], th: ['th'],
    };
    for (const [target, langs] of Object.entries(sameScript)) {
      for (const lang of langs) {
        for (const text of CORPUS[lang]) {
          expect(isMismatchNew(text, target), `${lang} vs ${target}`).toBe(false);
        }
      }
    }
  });

  it('only ever becomes stricter where the model ABSTAINED, on every target', () => {
    // Swept across every target rather than spot-checked, and it corrects a
    // wrong guess: "the new filter never drops what the model kept" is FALSE.
    // On target=ru it also drops Portuguese, Italian and Chinese results the
    // model kept.
    //
    // The true invariant is narrower and more useful. Every case where the new
    // filter drops something the model kept is a case where the model returned
    // 'und' — it scored under its own 0.1 confidence floor and had NO opinion,
    // so the old filter kept a wrong-script result by default. The new filter
    // never overrides a positive judgement from the model; it only decides
    // where the model declined to.
    //
    // That is the whole behavioural delta in one sentence, and it is the thing
    // that must not silently change.
    for (const target of [...LATIN_TARGETS, ...NON_LATIN_TARGETS]) {
      const d = compare(target);
      expect(d.total, `target=${target}`).toBe(35);
      for (const { lang, oldLang } of d.newDropsOldKeepsVerdict) {
        expect(
          oldLang,
          `target=${target}: newly dropped a ${lang} result the model had a real opinion about`,
        ).toBe('und');
      }
    }
  });

  it('keeps same-script neighbours that the model would have dropped', () => {
    // The measured cost, named precisely. With target=ru, Ukrainian, Bulgarian
    // and Serbian results now survive; the old model dropped them.
    const ru = compare('ru');
    expect(ru.newKeepsOldDrops).toEqual(expect.arrayContaining(['uk', 'bg', 'sr']));

    // And the reverse, which is the case the old behaviour got WRONG for users:
    // with target=uk it dropped every Russian-script neighbour too.
    const uk = compare('uk');
    expect(uk.newKeepsOldDrops).toEqual(expect.arrayContaining(['ru']));
  });

  it('still separates every distinct script from an English target', () => {
    // The property the filter exists for: a batch of non-Latin results against
    // an English query must still be recognised as non-target.
    for (const lang of ['ru', 'zh', 'ja', 'ko', 'ar', 'he', 'el', 'hi', 'th', 'bn', 'ta']) {
      for (const text of CORPUS[lang]) {
        expect(isMismatchNew(text, 'en'), `${lang} vs en`).toBe(true);
      }
    }
    for (const lang of LATIN_TARGETS) {
      for (const text of CORPUS[lang]) {
        expect(isMismatchNew(text, 'en'), `${lang} vs en`).toBe(false);
      }
    }
  });

  it('reads a non-Latin result carrying Latin brand names as non-Latin', () => {
    // Real search results mix scripts: a Japanese page titled with "API" in
    // ASCII must not be scored as Latin because a minority of it is.
    expect(detectScript('AIエージェントのためのローカルファーストウェブ検索')).toBe('han');
    expect(detectScript('API 入门：身份验证、速率限制和分页说明的完整技术文档')).toBe('han');
    expect(detectScript('Локальний веб-пошук для ШІ-агентів API документація')).toBe('cyrillic');
  });

  it('declines to guess on text too short to carry a signal', () => {
    expect(detectScript('hi')).toBe('und');
    expect(detectScript('')).toBe('und');
    // 'und' must never cause a drop.
    expect(isMismatchNew('hi', 'ru')).toBe(false);
  });

  it('does not filter when the target language is unknown to us', () => {
    // Fail open: an unmapped target must not silently delete every result.
    const results = Object.entries(CORPUS).slice(0, 6).map(([lang, texts], i) => ({
      url: `https://example.com/${i}`,
      title: texts[0],
      snippet: '',
      engine: 'bing',
    }));
    const out = filterByLanguage(results, { target: 'xx', dropThreshold: 0.4 });
    expect(out.results).toHaveLength(results.length);
    expect(out.discarded).toEqual([]);
  });

  it('does not import the language model in src/', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'search', 'language-filter.ts'),
      'utf-8',
    );
    expect(source).not.toMatch(/tinyld/);
  });
});
