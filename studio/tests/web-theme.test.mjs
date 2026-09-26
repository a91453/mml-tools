// Studio main page light/dark theme: every colour token has a dark value, the
// page keeps Studio's CSP, boot.js applies only the theme (the page stays
// zh-Hant whatever language the Workshop stores), and the preference is the
// one the Workshop shares.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const web = new URL('../web/', import.meta.url);
const read = name => readFile(new URL(name, web), 'utf8');

test('the dark theme redefines every colour token the light theme defines', async () => {
  const css = await read('style.css');
  const block = selector => css.slice(css.indexOf(`${selector}{`)).split('}')[0];
  const names = text => new Set([...text.matchAll(/(--[a-z0-9-]+):#/g)].map(m => m[1]));
  const light = names(block(':root'));
  const dark = names(block(':root[data-theme="dark"]'));
  assert.ok(light.size > 50);
  for (const name of light) assert.ok(dark.has(name), `dark theme defines ${name}`);
  const roll = names(block('.roll-card,.listen-roll'));
  const darkRoll = names(block(':root[data-theme="dark"] .roll-card,:root[data-theme="dark"] .listen-roll'));
  assert.ok(roll.size > 20);
  for (const name of roll) assert.ok(darkRoll.has(name), `dark review roll defines ${name}`);
  // Outside the token blocks, colours come from tokens only.
  const rest = css.replace(/:root\{[^}]*\}|:root\[data-theme="dark"\][^{]*\{[^}]*\}|\.roll-card,\.listen-roll\{[^}]*\}/g, '');
  assert.deepEqual(rest.match(/#[0-9a-f]{3,8}\b|\b(?:white|black)\b(?![-])/gi), null);
  assert.doesNotMatch(css, /data-i18n/, 'no translation hook is left');
});

test('the page keeps Studio\'s CSP, stays zh-Hant, and paints the theme from an external script', async () => {
  const html = await read('index.html');
  assert.match(html, /<html lang="zh-Hant">/);
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
  assert.match(html, /<script src="\.\/studio\/web\/boot\.js"><\/script>/);
  assert.doesNotMatch(html, /\sstyle=|<style\b|\son[a-z]+=/i);
  assert.doesNotMatch(html, /data-i18n|id="lang"/, 'no language picker or translation hook');
  assert.match(html, /<select id="theme"><option value="system">跟隨系統<\/option><option value="light">淺色<\/option><option value="dark">深色<\/option><\/select>/);
  for (const file of ['boot.js', 'ui-prefs.mjs']) assert.doesNotMatch(await read(file), /https?:\/\/|style=\\?"/, file);
});

// boot.js run against a stored preference and a system scheme.
async function boot({ stored = null, systemDark = false }) {
  const attributes = { lang: 'zh-Hant' };
  const meta = { content: '#122a32', setAttribute(name, value) { this[name] = value; } };
  const context = vm.createContext({
    document: { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } }, querySelector: () => meta },
    localStorage: { getItem: () => stored },
    window: { matchMedia: () => ({ matches: systemDark }) },
    matchMedia: () => ({ matches: systemDark }),
    navigator: { languages: ['ja-JP'] },
  });
  vm.runInContext(await read('boot.js'), context);
  return { attributes, bar: meta.content };
}

test('boot.js applies the stored theme, else the system one, and never touches the language', async () => {
  assert.deepEqual(await boot({ stored: JSON.stringify({ theme: 'dark', lang: 'ja' }) }), { attributes: { lang: 'zh-Hant', 'data-theme': 'dark' }, bar: '#0b1a1f' });
  assert.deepEqual(await boot({ stored: JSON.stringify({ theme: 'light' }), systemDark: true }), { attributes: { lang: 'zh-Hant', 'data-theme': 'light' }, bar: '#122a32' });
  assert.deepEqual((await boot({ stored: null, systemDark: true })).attributes, { lang: 'zh-Hant', 'data-theme': 'dark' });
  assert.deepEqual((await boot({ stored: '{broken', systemDark: false })).attributes, { lang: 'zh-Hant', 'data-theme': 'light' });
  const code = (await read('boot.js')).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /lang|i18n|navigator/i, 'no language detection');
});

test('Studio and the Workshop read and write the same stored theme', async () => {
  const boot = await read('boot.js');
  assert.match(boot, /localStorage\.getItem\("studio-workshop\/ui"\)/);
  assert.match(await read('ui-prefs.mjs'), /export const UI_KEY = 'studio-workshop\/ui'/);
  assert.match(await read('workshop/storage.mjs'), /export const UI_KEY = "studio-workshop\/ui"/);
  assert.match(await read('workshop/boot.js'), /ui\.theme === "light" \|\| ui\.theme === "dark"/);
});

test('setTheme keeps the Workshop\'s other preferences and "system" forgets the stored theme', async () => {
  const store = new Map([['studio-workshop/ui', JSON.stringify({ lang: 'ko', autosave: true, theme: 'light' })]]);
  const root = { dataset: {} };
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  globalThis.document = { documentElement: root, querySelector: () => null };
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const prefs = await import('../web/ui-prefs.mjs');
    assert.equal(prefs.themeChoice(), 'light');
    prefs.setTheme('dark');
    assert.deepEqual(JSON.parse(store.get('studio-workshop/ui')), { lang: 'ko', autosave: true, theme: 'dark' });
    assert.equal(root.dataset.theme, 'dark');
    prefs.setTheme('system');
    assert.deepEqual(JSON.parse(store.get('studio-workshop/ui')), { lang: 'ko', autosave: true });
    assert.equal(prefs.themeChoice(), 'system');
    assert.equal(root.dataset.theme, 'dark', 'follows the (dark) system');
  } finally {
    delete globalThis.localStorage; delete globalThis.document; delete globalThis.matchMedia;
  }
});
