/**
 * Display preferences that belong to the machine, not the shop.
 *
 * Theme and language change nothing about the data, so they are deliberately
 * NOT settings rows: they need no migration, no role check, and two tills in
 * the same shop may reasonably differ. localStorage is the right scope — it
 * survives a restart and stays on this PC.
 */
import { createContext, useContext } from 'react';

export const THEMES = ['warm', 'light'] as const;
export type Theme = (typeof THEMES)[number];

const THEME_KEY = 'jp.theme';

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v && (THEMES as readonly string[]).includes(v)) return v as Theme;
  } catch {
    // A locked-down profile can refuse storage; the default still works.
  }
  return 'warm';
}

/** The warm theme is the stylesheet's own `:root`, so it carries no attribute —
 * only the alternative is stamped. That keeps the default path free of an
 * extra selector and makes "no attribute" mean "as shipped". */
export function applyTheme(theme: Theme): void {
  const el = document.documentElement;
  if (theme === 'warm') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', theme);
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not remembering the choice must not prevent making it.
  }
  applyTheme(theme);
}

/* ── React binding ─────────────────────────────────────────────────────── */
/* The theme has to live in React state, not just on the DOM: antd's palette is
   a prop on ConfigProvider, so App must re-render when the theme changes. */

export interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

export const ThemeContext = createContext<ThemeCtx>({
  theme: 'warm',
  setTheme: () => {},
});

export function useTheme(): ThemeCtx {
  return useContext(ThemeContext);
}
