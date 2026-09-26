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

// Hints must not claim game behaviour the Canonical rules leave PENDING
// (MOBILE_SYNTAX §3 / P4 lengths 1–64, §4 / P5 multi-dot, §9 / P1 counting),
// nor describe a right click on the ruler or the roll as setting the end
// line or deleting: both open a menu (pianoroll.mjs openMenu).
test('hints claim no unverified game behaviour and describe right click as a menu', async () => {
  const unverified = {
    'zh-Hant': /不吃|吃不下|遊戲不支援|遊戲算的字數|右鍵設結束|右鍵刪除/,
    en: /will not accept|does not accept|what the game counts|right click the end|right click deletes/,
    ja: /では使えません|受け付けない|受け付けません|ゲームの数える|右クリックで終了|右クリックで削除/,
    ko: /Mobile에서는 쓸 수 없|받지 않는|게임이 세는 글자|우클릭이 끝|우클릭으로 삭제/,
  };
  for (const tag of LANGS) {
    for (const [key, value] of Object.entries(tables[tag])) assert.doesNotMatch(JSON.stringify(value), unverified[tag], `${tag} ${key}`);
  }
  const html = await readFile(new URL('index.html', dir), 'utf8');
  assert.doesNotMatch(html, unverified['zh-Hant']);
  for (const key of ['html.rollHint', 'html.clipBox.0.3']) assert.ok(html.includes(`data-i18n="${key}">${tables['zh-Hant'][key]}<`), `${key} static text`);
  for (const key of ['html.rangeSel.1@title', 'html.toolSelect@title']) assert.ok(html.includes(`title="${tables['zh-Hant'][key]}"`), `${key} static text`);
  const guide = new URL('guide/', dir);
  for (const name of await readdir(guide)) {
    if (name.endsWith('.html')) assert.doesNotMatch((await readFile(new URL(name, guide), 'utf8')).replace(/不能只因為[^；。]*不吃/g, ''), /Mobile (?:可能)?不吃|遊戲算的字數|右鍵<\/strong>點一下設結束/, name);
  }
});
