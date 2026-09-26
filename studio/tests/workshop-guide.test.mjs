// Workshop help pages (studio/web/workshop/guide/): Studio's CSP, only the
// allowed markup, every internal link and anchor resolves, and the three
// translations keep each page's structure (anchors, links, tables, key caps,
// Workshop-only and Canonical boxes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const dir = new URL('../web/workshop/guide/', import.meta.url);
const PAGES = ['editor', 'keys', 'mobile', 'reference', 'mml', 'midi', 'faq'];
const LANGS = ['en', 'ja', 'ko'];
const read = async name => readFile(new URL(name, dir), 'utf8');
const article = html => /<main id="guide">([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
const count = (html, re) => (html.match(re) ?? []).length;
const ids = html => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]).sort();
const hrefs = html => [...html.matchAll(/\shref="([^"]+)"/g)].map(m => m[1]).sort();
const ALLOWED = new Set(['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 'code', 'kbd', 'pre', 'a', 'br', 'div']);
const shape = html => Object.fromEntries([
  ['h2', /<h2\b/g], ['h3', /<h3\b/g], ['table', /<table\b/g], ['tr', /<tr\b/g], ['li', /<li\b/g], ['kbd', /<kbd\b/g], ['pre', /<pre\b/g],
  ['note', /<div class="note"/g], ['workshop-only', /<div class="workshop-only"/g], ['canonical', /<div class="canonical"/g],
].map(([name, re]) => [name, count(html, re)]));
const translations = Object.fromEntries(await Promise.all(LANGS.map(async tag => [tag, (await import(new URL(`i18n/${tag}.mjs`, dir))).default])));

test('the seven pages exist, and guide.mjs knows exactly them', async () => {
  const files = (await readdir(dir)).filter(name => name.endsWith('.html')).map(name => name.slice(0, -5)).sort();
  assert.deepEqual(files, [...PAGES].sort());
  const script = await read('guide.mjs');
  assert.match(script, new RegExp(`export const PAGES = \\[${PAGES.map(p => `"${p}"`).join(', ')}\\]`));
});

test('every page keeps the CSP: no inline script, style or handler, nothing external', async () => {
  for (const name of PAGES) {
    const html = await read(`${name}.html`);
    assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self';/, name);
    assert.match(html, new RegExp(`<body data-guide="${name}">`), name);
    assert.deepEqual([...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0]), ['<script src="../boot.js">', '<script type="module" src="./guide.mjs">'], `${name} scripts`);
    assert.doesNotMatch(html, /\sstyle=|<style\b|\son[a-z]+=/i, name);
    assert.doesNotMatch(html, /https?:\/\//, `${name} names no URL`);
  }
  for (const tag of LANGS) for (const name of PAGES) {
    const html = translations[tag][name];
    assert.doesNotMatch(html, /\sstyle=|<style\b|<script\b|\son[a-z]+=|https?:\/\//i, `${tag} ${name}`);
  }
});

test('articles use only the allowed markup, in every language', async () => {
  const check = (html, where) => {
    for (const [, tag] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) assert.ok(ALLOWED.has(tag.toLowerCase()), `${where}: <${tag}>`);
    for (const [, cls] of html.matchAll(/<div class="([^"]*)"/g)) assert.ok(['note', 'toc', 'workshop-only', 'canonical'].includes(cls), `${where}: div.${cls}`);
    assert.equal(count(html, /<div\b/g), count(html, /<\/div>/g), `${where}: balanced div`);
    assert.equal(count(html, /<h1\b/g), 1, `${where}: one h1`);
  };
  for (const name of PAGES) check(article(await read(`${name}.html`)), `zh-Hant ${name}`);
  for (const tag of LANGS) for (const name of PAGES) check(translations[tag][name], `${tag} ${name}`);
});

test('every internal link resolves to a page that exists, and every #anchor to an id on it', async () => {
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  const guideDir = fileURLToPath(dir);
  const idsOf = new Map(await Promise.all(PAGES.map(async name => [`${name}.html`, new Set(ids(article(await read(`${name}.html`))))])));
  const checkLinks = (html, name, where) => {
    for (const href of hrefs(html)) {
      const [path, anchor] = href.split('#');
      const target = path ? resolve(guideDir, path) : resolve(guideDir, `${name}.html`);
      const inGuide = dirname(target) === resolve(guideDir);
      // The Studio root page is built from studio/web/index.html.
      const source = target === resolve(webRoot, '../../index.html') ? resolve(webRoot, 'index.html') : target;
      assert.ok(existsSync(source), `${where}: ${href}`);
      if (anchor && inGuide) assert.ok(idsOf.get(target.slice(guideDir.length))?.has(anchor), `${where}: #${anchor} on ${path || `${name}.html`}`);
    }
  };
  for (const name of PAGES) checkLinks(await read(`${name}.html`), name, `zh-Hant ${name}`);
  for (const tag of LANGS) for (const name of PAGES) checkLinks(translations[tag][name], name, `${tag} ${name}`);
});

test('each translation keeps its page\'s anchors, links and structure', async () => {
  for (const name of PAGES) {
    const zh = article(await read(`${name}.html`));
    for (const tag of LANGS) {
      const html = translations[tag][name];
      assert.equal(typeof html, 'string', `${tag} ${name}`);
      assert.deepEqual(ids(html), ids(zh), `${tag} ${name} anchors`);
      assert.deepEqual(hrefs(html), hrefs(zh), `${tag} ${name} links`);
      assert.deepEqual(shape(html), shape(zh), `${tag} ${name} structure`);
      assert.doesNotMatch(html.replace(/<(code|pre|kbd)>[\s\S]*?<\/\1>/g, ''), tag === 'en' ? /[一-鿿]/ : /$^/, `${tag} ${name} is translated`);
    }
  }
});

test('the pages carry none of the removed features', async () => {
  for (const name of PAGES) {
    const text = article(await read(`${name}.html`)).replace(/<[^>]+>/g, '');
    assert.doesNotMatch(text, /登入|登出|帳號|分享連結|雲端|OMR|環境音|殘響|lamejs|伺服器存檔/, name);
  }
});

test('the Workshop links to every page from its About panel', async () => {
  const workshop = await readFile(new URL('../web/workshop/index.html', import.meta.url), 'utf8');
  for (const name of PAGES) assert.ok(workshop.includes(`href="./guide/${name}.html"`), name);
});
