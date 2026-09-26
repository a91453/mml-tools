// Language and theme for the Studio main page. One preference serves Studio
// and the Workshop: both read and write `studio-workshop/ui` (the Workshop's
// key, workshop/storage.mjs), so a choice made on either page holds on both.
// boot.js applies it before first paint; this module changes it afterwards.
import { LANGS } from './i18n-core.mjs';

export const UI_KEY = 'studio-workshop/ui';
export const THEMES = ['system', 'light', 'dark'];
const BAR = { light: '#122a32', dark: '#0b1a1f' };

export function readPrefs() {
  try {
    const value = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

export function savePrefs(prefs) {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ ...readPrefs(), ...prefs })); return true; }
  catch { return false; }
}

// The stored choice: 'light' or 'dark', or 'system' when none is stored (the
// Workshop keeps only light/dark; anything else means "follow the system").
export const themeChoice = () => { const theme = readPrefs().theme; return theme === 'light' || theme === 'dark' ? theme : 'system'; };

export function resolvedTheme(choice = themeChoice()) {
  if (choice === 'light' || choice === 'dark') return choice;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(choice = themeChoice()) {
  const theme = resolvedTheme(choice);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR[theme]);
  return theme;
}

export function setTheme(choice) {
  if (!THEMES.includes(choice)) return applyTheme();
  if (choice === 'system') {
    const { theme, ...rest } = readPrefs();
    try { localStorage.setItem(UI_KEY, JSON.stringify(rest)); } catch { /* this page only */ }
  } else savePrefs({ theme: choice });
  return applyTheme(choice);
}

export const langChoice = () => (LANGS.includes(document.documentElement.lang) ? document.documentElement.lang : 'zh-Hant');
