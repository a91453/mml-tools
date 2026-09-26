// Workshop help pages (studio/web/workshop/guide/): zh-Hant only, Studio's
// CSP, only the allowed markup, every internal link and anchor resolves, none
// of the removed features, and the Workshop's About panel links to each page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const dir = new URL('../web/workshop/guide/', import.meta.url);
const PAGES = ['editor', 'reference', 'keys', 'mobile', 'mml', 'midi', 'faq'];
const read = async name => readFile(new URL(name, dir), 'utf8');
const article = html => /<main id="guide">([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
const count = (html, re) => (html.match(re) ?? []).length;
const ids = html => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const hrefs = html => [...html.matchAll(/\shref="([^"]+)"/g)].map(m => m[1]);
const ALLOWED = new Set(['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 'code', 'kbd', 'pre', 'a', 'br', 'div']);

test('the seven pages exist, and guide.mjs knows exactly them', async () => {
  const files = (await readdir(dir)).filter(name => name.endsWith('.html')).map(name => name.slice(0, -5)).sort();
  assert.deepEqual(files, [...PAGES].sort());
  assert.match(await read('guide.mjs'), new RegExp(`export const PAGES = \\[${PAGES.map(p => `"${p}"`).join(', ')}\\]`));
});

test('every page is zh-Hant only: no language picker, no translation hook, no language notice', async () => {
  const files = await readdir(dir);
  assert.ok(!files.includes('i18n'), 'no translation tables');
  for (const name of PAGES) {
    const html = await read(`${name}.html`);
    assert.match(html, /^<!doctype html>\n<html lang="zh-Hant">/, name);
    assert.doesNotMatch(html, /data-i18n|<select\b|id="guideLang"/, name);
    assert.doesNotMatch(html, /zhOnly|目前只有中文版/, `${name} needs no zh-only line`);
  }
  const script = await read('guide.mjs');
  assert.doesNotMatch(script, /i18n|import\b|loadUI/, 'guide.mjs loads no language');
  assert.doesNotMatch((await read('boot.js')).replace(/^\s*\/\/.*$/gm, ''), /lang|i18n|navigator/i, 'boot.js applies the theme only');
});

test('every page keeps the CSP: no inline script, style or handler, nothing external', async () => {
  for (const name of PAGES) {
    const html = await read(`${name}.html`);
    assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self';/, name);
    assert.match(html, new RegExp(`<body data-guide="${name}">`), name);
    assert.deepEqual([...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0]), ['<script src="./boot.js">', '<script type="module" src="./guide.mjs">'], `${name} scripts`);
    assert.doesNotMatch(html, /\sstyle=|<style\b|\son[a-z]+=/i, name);
    assert.doesNotMatch(html, /https?:\/\//, `${name} names no URL`);
  }
});

test('articles use only the allowed markup', async () => {
  for (const name of PAGES) {
    const html = article(await read(`${name}.html`));
    for (const [, tag] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) assert.ok(ALLOWED.has(tag.toLowerCase()), `${name}: <${tag}>`);
    for (const [, cls] of html.matchAll(/<div class="([^"]*)"/g)) assert.ok(['note', 'toc', 'workshop-only', 'canonical'].includes(cls), `${name}: div.${cls}`);
    for (const tag of ['div', 'table', 'ul', 'ol', 'p', 'pre', 'strong', 'code', 'kbd', 'a']) assert.equal(count(html, new RegExp(`<${tag}\\b`, 'g')), count(html, new RegExp(`</${tag}>`, 'g')), `${name}: balanced <${tag}>`);
    assert.equal(count(html, /<h1\b/g), 1, `${name}: one h1`);
    const seen = ids(html);
    assert.equal(new Set(seen).size, seen.length, `${name}: unique ids`);
  }
});

test('every internal link resolves to a page that exists, and every #anchor to an id on it', async () => {
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  const guideDir = resolve(fileURLToPath(dir));
  const idsOf = new Map(await Promise.all(PAGES.map(async name => [`${name}.html`, new Set(ids(article(await read(`${name}.html`))))])));
  for (const name of PAGES) {
    for (const href of hrefs(await read(`${name}.html`))) {
      const [path, anchor] = href.split('#');
      const target = path ? resolve(guideDir, path) : resolve(guideDir, `${name}.html`);
      // The build's root files (index.html, icon.svg) come from studio/web/.
      const source = dirname(target) === resolve(webRoot, '../..') ? resolve(webRoot, target.slice(dirname(target).length + 1)) : target;
      assert.ok(existsSync(source), `${name}: ${href}`);
      if (anchor && dirname(target) === guideDir) assert.ok(idsOf.get(target.slice(guideDir.length + 1))?.has(anchor), `${name}: #${anchor} on ${path || `${name}.html`}`);
    }
  }
});

test('the pages carry none of the removed features', async () => {
  for (const name of PAGES) {
    const text = article(await read(`${name}.html`)).replace(/<[^>]+>/g, '');
    assert.doesNotMatch(text, /登入|登出|帳號|分享連結|雲端|OMR|環境音|殘響|lamejs|伺服器存檔|歌唱譜|樂器譜|同步所有樂譜|1600/, name);
  }
});

test('the Workshop links to every page from its About panel, and keeps only those guide keys', async () => {
  const workshop = await readFile(new URL('../web/workshop/index.html', import.meta.url), 'utf8');
  for (const name of PAGES) assert.ok(workshop.includes(`href="./guide/${name}.html"`), name);
  const zh = (await import('../web/workshop/i18n/zh-Hant.mjs')).default;
  const guideKeys = Object.keys(zh).filter(key => key.startsWith('guide.')).sort();
  assert.deepEqual(guideKeys, ['guide.aboutTitle', ...PAGES.map(p => `guide.desc.${p}`), ...PAGES.map(p => `guide.nav.${p}`)].sort());
  for (const key of guideKeys) assert.ok(workshop.includes(`data-i18n="${key}"`), `${key} is used by the About panel`);
});
