// Studio main page i18n and theme: the four tables stay in step, every key
// the page asks for exists, status codes are never translated, and the page
// keeps Studio's CSP (no inline script or style, nothing external).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGS, createI18n, pageKeys } from '../web/i18n-core.mjs';

const web = new URL('../web/', import.meta.url);
const tables = Object.fromEntries(await Promise.all(LANGS.map(async tag => [tag, (await import(new URL(`i18n/${tag}.mjs`, web))).default])));
const base = tables['zh-Hant'];
const placeholders = v => new Set([...String(v).matchAll(/\{(\w+)(?::[^}]*)?\}/g)].map(m => m[1]));
const tags = v => [...String(v).matchAll(/<\/?([a-z]+)\b/g)].map(m => m[0]).sort();
// Codes the page shows as data. A translation carries each one verbatim.
const CODES = ['PASS', 'FAIL', 'PENDING', 'UNSUPPORTED', 'VALIDATED', 'CANDIDATE', 'IN_GAME_ACCEPTED', 'TECHNICAL_PASS', 'SOURCE_PASS', 'PLAYER_READBACK_PASS', 'AUDIO_ALIGNMENT_PASS', 'MOBILE_ADAPTATION_PASS', 'FIXTURE_PENDING', 'N/A'];
const codesIn = v => new Set(CODES.filter(code => new RegExp(`(^|[^A-Z_])${code.replace('/', '\\/')}($|[^A-Z_])`).test(String(v))));

test('the four tables have exactly the same keys, placeholders and markup', () => {
  const keys = Object.keys(base).sort();
  assert.ok(keys.length > 600);
  for (const tag of LANGS) {
    assert.deepEqual(Object.keys(tables[tag]).sort(), keys, `${tag} key set`);
    for (const key of keys) {
      const value = tables[tag][key];
      assert.equal(typeof value, 'string', `${tag} ${key} shape`);
      assert.ok(value.trim(), `${tag} ${key} is empty`);
      assert.deepEqual(placeholders(value), placeholders(base[key]), `${tag} ${key} placeholders`);
      assert.deepEqual(tags(value), tags(base[key]), `${tag} ${key} markup`);
    }
  }
});

test('gate and status codes stay verbatim in every language', () => {
  for (const tag of LANGS) for (const [key, value] of Object.entries(base)) {
    for (const code of codesIn(value)) assert.ok(codesIn(tables[tag][key]).has(code), `${tag} ${key} keeps ${code}`);
  }
});

test('every key the page and app.mjs ask for exists', async () => {
  const html = await readFile(new URL('index.html', web), 'utf8');
  const app = await readFile(new URL('app.mjs', web), 'utf8');
  const wanted = new Set(pageKeys(html));
  for (const m of app.matchAll(/\bt\(\s*'([^']+)'/g)) wanted.add(m[1]);
  // Keys built from a name: each name the page can pass has an entry.
  for (const name of ['source', 'version', 'lead', 'core3', 'full6', 'tempo', 'audio', 'adaptation', 'regression']) wanted.add(`reviewLabel.${name}`);
  for (const slot of ['candidate', 'baseline', 'previous']) wanted.add(`slot.${slot}`);
  for (const origin of ['generated', 'pasted', 'candidate-source']) wanted.add(`origin.${origin}`);
  for (const view of ['source', 'accepted', 'preview']) wanted.add(`roll.view.${view}`);
  for (const type of ['ASSIGN_ROLE', 'MOVE_ROLE', 'OMIT_FROM_SIX', 'DUPLICATE_WITH_JUSTIFICATION', 'KEEP']) wanted.add(`decision.type.${type}`);
  assert.ok(wanted.size > 550);
  for (const key of wanted) assert.ok(key in base, `missing key ${key}`);
});

test('every review name the model records has a label', async () => {
  const { REVIEW_NAMES } = await import('../web/model.mjs');
  for (const name of REVIEW_NAMES) assert.ok(`reviewLabel.${name}` in base, `reviewLabel.${name}`);
});

test('a missing table leaves the page in zh-Hant; a present one is used with the zh-Hant fallback', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const i18n = createI18n({ base: { a: '甲', b: '乙 {n}' }, load: async tag => { if (tag === 'en') return { default: { a: 'A' } }; throw Error('missing'); }, label: '[test]' });
    await i18n.use('ja');
    assert.equal(i18n.getLocale(), 'zh-Hant');
    assert.equal(i18n.t('a'), '甲');
    assert.equal(errors.length, 1);
    await i18n.use('en');
    assert.equal(i18n.getLocale(), 'en');
    assert.equal(i18n.t('a'), 'A');
    assert.equal(i18n.t('b', { n: 2 }), '乙 2', 'a key the table lacks falls back to zh-Hant');
  } finally { console.error = original; }
});

test('boot.js offers exactly the four languages and reads the preference the Workshop shares', async () => {
  const boot = await readFile(new URL('boot.js', web), 'utf8');
  assert.match(boot, new RegExp(`var tags = \\[${LANGS.map(tag => `"${tag}"`).join(', ')}\\]`));
  assert.match(boot, /localStorage\.getItem\("studio-workshop\/ui"\)/);
  const prefs = await readFile(new URL('ui-prefs.mjs', web), 'utf8');
  assert.match(prefs, /export const UI_KEY = 'studio-workshop\/ui'/);
  const workshop = await readFile(new URL('workshop/storage.mjs', web), 'utf8');
  assert.match(workshop, /export const UI_KEY = "studio-workshop\/ui"/);
});

test('the page keeps Studio Web\'s CSP: no inline script, style or handler, nothing external', async () => {
  const html = await readFile(new URL('index.html', web), 'utf8');
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
  assert.match(html, /<script src="\.\/studio\/web\/boot\.js"><\/script>/, 'first paint from an external classic script');
  assert.doesNotMatch(html, /\sstyle=/, 'no style attribute');
  assert.doesNotMatch(html, /\son[a-z]+=/, 'no inline event handler');
  assert.doesNotMatch(html, /<style\b/);
  for (const file of ['boot.js', 'ui-prefs.mjs', 'i18n.mjs', 'i18n-core.mjs', ...LANGS.map(tag => `i18n/${tag}.mjs`)]) {
    const text = await readFile(new URL(file, web), 'utf8');
    assert.doesNotMatch(text, /https?:\/\//, `${file} names no URL`);
    assert.doesNotMatch(text, /style=\\?"/, `${file} builds no inline style`);
  }
});

test('the dark theme redefines every colour token the light theme defines', async () => {
  const css = await readFile(new URL('style.css', web), 'utf8');
  const block = selector => css.slice(css.indexOf(`${selector}{`)).split('}')[0];
  const names = text => new Set([...text.matchAll(/(--[a-z0-9-]+):#/g)].map(m => m[1]));
  const light = names(block(':root'));
  const dark = names(block(':root[data-theme="dark"]'));
  assert.ok(light.size > 50);
  for (const name of light) assert.ok(dark.has(name), `dark theme defines ${name}`);
  const roll = names(block('.roll-card,.listen-roll'));
  const darkRoll = names(block(':root[data-theme="dark"] .roll-card,:root[data-theme="dark"] .listen-roll'));
  for (const name of roll) assert.ok(darkRoll.has(name), `dark roll defines ${name}`);
  // Outside the token blocks, colours come from tokens only.
  const rest = css.replace(/:root\{[^}]*\}|:root\[data-theme="dark"\][^{]*\{[^}]*\}|\.roll-card,\.listen-roll\{[^}]*\}/g, '');
  assert.deepEqual(rest.match(/#[0-9a-f]{3,8}\b|\b(?:white|black)\b(?![-])/gi), null);
});
