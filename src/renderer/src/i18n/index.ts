/** i18n bootstrap. English only in v1, but every string routes through `t()`
 * and the document `dir` follows the language so Urdu (RTL) is a JSON file away. */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

export const SUPPORTED = ['en', 'ur'] as const;
export type Lang = (typeof SUPPORTED)[number];
export const RTL_LANGS: Lang[] = ['ur'];

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function isRtl(lang: string): boolean {
  return (RTL_LANGS as string[]).includes(lang);
}

export default i18n;
