/**
 * Theme controller — dark (default) / light bunq palettes.
 *
 * The theme is expressed as `data-theme` on <html>; every colour in the app
 * resolves through the CSS custom properties declared in index.css, so a single
 * attribute flip re-paints the whole dashboard with no React re-render needed
 * for styling. The hook exists only so the toggle can render the right glyph.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'bunqsy_theme';

/** Browser chrome colour so the mobile address bar matches the canvas. */
const META_THEME_COLOR: Record<Theme, string> = {
  dark:  '#000000',
  light: '#ffffff',
};

function prefersLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

export function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

/** Resolved theme for first paint: explicit choice → OS preference → dark. */
export function resolveInitialTheme(): Theme {
  return readStoredTheme() ?? (prefersLight() ? 'light' : 'dark');
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // Native form controls, scrollbars and `Highlight` follow this.
  root.style.colorScheme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META_THEME_COLOR[theme]);
}

/**
 * Reads/writes the active theme. Persists an explicit choice to localStorage
 * and — until the user makes one — keeps following the OS setting live.
 */
export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof document === 'undefined') return 'dark';
    const attr = document.documentElement.getAttribute('data-theme');
    return attr === 'light' || attr === 'dark' ? attr : resolveInitialTheme();
  });

  useEffect(() => { applyTheme(theme); }, [theme]);

  // Follow the OS while the user has not expressed a preference.
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia('(prefers-color-scheme: light)'); } catch { return; }
    const onChange = (e: MediaQueryListEvent): void => {
      if (readStoredTheme() === null) setThemeState(e.matches ? 'light' : 'dark');
    };
    mq.addEventListener('change', onChange);
    return (): void => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* private mode */ }
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
      return next;
    });
  }, []);

  return { theme, toggle, setTheme };
}
