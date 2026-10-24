/*!
 * Mmail · translation factory
 * ---------------------------------------------------------------------------
 * Locale data lives in locales.js (window.MmailLocales). This file only
 * resolves keys and substitutes {placeholders}.
 */
(function (global) {
  'use strict';

  const DICT = global.MmailLocales || { zh: {}, en: {} };

  /**
   * @param {'zh'|'en'} lang
   * @returns {(key: string, vars?: Record<string, string|number>) => string}
   */
  function translator(lang) {
    const table = DICT[lang] || DICT.zh;
    return function t(key, vars) {
      let text = table[key];
      if (text === undefined) text = DICT.zh[key];
      if (text === undefined) return key;
      if (!vars) return text;
      return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
      );
    };
  }

  global.MmailI18n = { DICT, translator, languages: ['zh', 'en'] };
})(typeof window !== 'undefined' ? window : globalThis);
