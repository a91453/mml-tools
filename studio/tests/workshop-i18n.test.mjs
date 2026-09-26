// Studio Workshop: one zh-Hant text table (the owner is the only user), the
// static page asks only for keys that exist, and the page keeps Studio's
// no-inline, no-external policy (CSP 'self', no icon font, no outside URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pageKeys } from '../web/workshop/i18n-page.mjs';

const dir = new URL('../web/workshop/', import.meta.url);
const zh = (await import(new URL('i18n/zh-Hant.mjs', dir))).default;

test('zh-Hant is the only table: no other language, no picker, no language loading', async () => {
  assert.deepEqual(await readdir(new URL('i18n/', dir)), ['zh-Hant.mjs']);
  assert.ok(!existsSync(new URL('lang.mjs', dir)), 'no language picker module');
  const html = await readFile(new URL('index.html', dir), 'utf8');
  assert.match(html, /^<!doctype html>\n<html lang="zh-Hant">/);
  assert.doesNotMatch(html, /id="lang"|語言 \(Language\)/);
  assert.doesNotMatch(await readFile(new URL('i18n.mjs', dir), 'utf8'), /import\(|PluralRules/);
  assert.doesNotMatch((await readFile(new URL('boot.js', dir), 'utf8')).replace(/^\s*\/\/.*$/gm, ''), /lang|navigator|i18n/i, 'boot.js applies the theme only');
  assert.doesNotMatch(await readFile(new URL('workshop.css', dir), 'utf8'), /i18n-pending/);
});

test('every entry is a non-empty string with plain {name} placeholders', () => {
  const table = zh;
  assert.ok(Object.keys(table).length > 700);
  for (const [key, value] of Object.entries(table)) {
    assert.equal(typeof value, 'string', `${key} shape`);
    assert.ok(value.trim() || key.endsWith('~0'), `${key} is empty`);
    assert.doesNotMatch(value, /\{\w+:[^}]*\}/, `${key} uses no particle form`);
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
  for (const key of wanted) assert.ok(key in zh, `missing key ${key}`);
});

test('the page keeps Studio Web\'s CSP: no inline script, style or handler, nothing external', async () => {
  const html = await readFile(new URL('index.html', dir), 'utf8');
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
  assert.doesNotMatch(html, /\sstyle=/, 'no style attribute');
  assert.doesNotMatch(html, /\son[a-z]+=/, 'no inline event handler');
  assert.doesNotMatch(html, /<style\b/);
  for (const file of ['index.html', 'workshop.css', 'boot.js', ...(await readdir(dir)).filter(f => f.endsWith('.mjs')), 'i18n/zh-Hant.mjs']) {
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
  const unverified = /不吃|吃不下|遊戲不支援|遊戲算的字數|右鍵設結束|右鍵刪除/;
  for (const [key, value] of Object.entries(zh)) assert.doesNotMatch(value, unverified, key);
  const html = await readFile(new URL('index.html', dir), 'utf8');
  assert.doesNotMatch(html, unverified);
  for (const key of ['html.rollHint', 'html.clipBox.0.3']) assert.ok(html.includes(`data-i18n="${key}">${zh[key]}<`), `${key} static text`);
  for (const key of ['html.rangeSel.1@title', 'html.toolSelect@title']) assert.ok(html.includes(`title="${zh[key]}"`), `${key} static text`);
  const guide = new URL('guide/', dir);
  for (const name of await readdir(guide)) {
    if (name.endsWith('.html')) assert.doesNotMatch((await readFile(new URL(name, guide), 'utf8')).replace(/不能只因為[^；。]*不吃/g, ''), /Mobile (?:可能)?不吃|遊戲算的字數|右鍵<\/strong>點一下設結束/, name);
  }
});
