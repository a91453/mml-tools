// Studio Workshop: the four UI languages stay in step, the static page asks
// only for keys that exist, and the page keeps Studio's no-inline, no-external
// policy (CSP 'self', no icon font, no outside URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { pageKeys } from '../web/workshop/i18n-page.mjs';

const dir = new URL('../web/workshop/', import.meta.url);
const LANGS = ['zh-Hant', 'en', 'ja', 'ko'];
const tables = Object.fromEntries(await Promise.all(LANGS.map(async tag => [tag, (await import(new URL(`i18n/${tag}.mjs`, dir))).default])));
const placeholders = v => new Set([...JSON.stringify(v).matchAll(/\{(\w+)(?::[^}]*)?\}/g)].map(m => m[1]));

test('the four tables have exactly the same keys and placeholders', () => {
  const base = Object.keys(tables['zh-Hant']).sort();
  assert.ok(base.length > 700);
  for (const tag of LANGS) {
    assert.deepEqual(Object.keys(tables[tag]).sort(), base, `${tag} key set`);
    for (const key of base) {
      const value = tables[tag][key];
      assert.ok(typeof value === 'string' || (value && typeof value.other === 'string'), `${tag} ${key} shape`);
      assert.deepEqual(placeholders(value), placeholders(tables['zh-Hant'][key]), `${tag} ${key} placeholders`);
      if (typeof value === 'string') assert.ok(value.trim() || key.endsWith('~0'), `${tag} ${key} is empty`);
    }
  }
});

test('every key the page and the modules ask for exists', async () => {
  const html = await readFile(new URL('index.html', dir), 'utf8');
  const wanted = new Set(pageKeys(html));
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.mjs'))) {
    const code = await readFile(new URL(file, dir), 'utf8');
    for (const m of code.matchAll(/\bi18n\.(?:t|has)\(\s*"([^"]+)"/g)) wanted.add(m[1]);
  }
  assert.ok(wanted.size > 300);
  for (const key of wanted) assert.ok(key in tables['zh-Hant'], `missing key ${key}`);
});

test('the page keeps Studio Web\'s CSP: no inline script, style or handler, nothing external', async () => {
  const html = await readFile(new URL('index.html', dir), 'utf8');
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
  assert.doesNotMatch(html, /\sstyle=/, 'no style attribute');
  assert.doesNotMatch(html, /\son[a-z]+=/, 'no inline event handler');
  assert.doesNotMatch(html, /<style\b/);
  for (const file of ['index.html', 'workshop.css', 'boot.js', ...(await readdir(dir)).filter(f => f.endsWith('.mjs')), ...LANGS.map(t => `i18n/${t}.mjs`)]) {
    const text = await readFile(new URL(file, dir), 'utf8');
    assert.doesNotMatch(text, /https?:\/\//, `${file} names no URL`);
    assert.doesNotMatch(text, /\/api\/|fa-solid|fa-regular|@font-face|@import/, `${file} has no server endpoint or font`);
    assert.doesNotMatch(text, /style=\\?"/, `${file} builds no inline style`);
  }
});
