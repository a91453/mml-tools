// Theme for the Studio main page. Studio and the Workshop share one stored
// preference, `studio-workshop/ui` (the Workshop's key, workshop/storage.mjs):
// a theme chosen on either page holds on both. Studio reads and writes only its
// `theme`; any other fields are left as they are.
// boot.js applies the theme before first paint; this module changes it later.
export const UI_KEY = 'studio-workshop/ui';
export const THEMES = ['system', 'light', 'dark'];
const BAR = { light: '#122a32', dark: '#0b1a1f' };

export function readPrefs() {
  try {
    const value = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function writePrefs(prefs) {
  try { localStorage.setItem(UI_KEY, JSON.stringify(prefs)); return true; } catch { return false; }
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
  const { theme, ...rest } = readPrefs();
  writePrefs(choice === 'system' ? rest : { ...rest, theme: choice });
  return applyTheme(choice);
}
