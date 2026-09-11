/** i18n bootstrap. English and Urdu; the document `dir` follows the language,
 * so switching to Urdu flips the whole interface right-to-left.
 *
 * Urdu is a partial translation: the counter workflow (sign-in, dashboard,
 * items, rates, sale, receipt) is covered, and anything not yet translated
 * falls back to English rather than showing a raw key. */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ur from './ur.json';

export const SUPPORTED = ['en', 'ur'] as const;
export type Lang = (typeof SUPPORTED)[number];
export const RTL_LANGS: Lang[] = ['ur'];

/** Language is a per-machine display preference, not shop data, so it lives in
 * localStorage rather than the database — it must survive a restart without a
 * migration, and two tills may reasonably differ. */
const LANG_KEY = 'jp.lang';

export function storedLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v && (SUPPORTED as readonly string[]).includes(v)) return v as Lang;
  } catch {
    // Private mode or a locked-down profile: fall through to the default.
  }
  return 'en';
}

export function isRtl(lang: string): boolean {
  return (RTL_LANGS as string[]).includes(lang);
}

/** Point of truth for a language change: stores it, tells i18next, and sets the
 * document's lang/dir so CSS logical properties and the caret follow. */
export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not being able to remember the choice must not block making it.
  }
  void i18n.changeLanguage(lang);
  applyDocumentLang(lang);
}

export function applyDocumentLang(lang: string): void {
  const el = document.documentElement;
  el.setAttribute('lang', lang);
  el.setAttribute('dir', isRtl(lang) ? 'rtl' : 'ltr');
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ur: { translation: ur } },
  lng: storedLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

applyDocumentLang(storedLang());

export default i18n;
