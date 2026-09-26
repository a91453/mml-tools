// Shared i18n engine for Studio Web pages (the Studio main page and the
// Workshop). Ported from the owner's earlier frontend (owner-authorized port):
// flat keys with a zh-Hant fallback, plurals and Korean particles.
// Gate and status codes (VALIDATED, PENDING, PASS…) are data, never keys: the
// tables carry them verbatim inside the translated sentences.

export const LANGS = ['zh-Hant', 'en', 'ja', 'ko'];

export const LANG_NAMES = {
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
};

const PARTICLES = {
  '은': ['은', '는'], '는': ['은', '는'],
  '이': ['이', '가'], '가': ['이', '가'],
  '을': ['을', '를'], '를': ['을', '를'],
  '과': ['과', '와'], '와': ['과', '와'],
  '으로': ['으로', '로'], '로': ['으로', '로'],
  '이라': ['이라', '라'], '라': ['이라', '라'],
};
const DIGIT_JONG = { 0: 1, 1: 1, 3: 1, 6: 1, 7: 1, 8: 1, 2: 0, 4: 0, 5: 0, 9: 0 };

function hasJong(s) {
  const t = String(s).trim();
  if (!t) return false;
  const c = t[t.length - 1];
  if (c >= '0' && c <= '9') return !!DIGIT_JONG[c];
  const code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  return false;
}

function particle(prev, form) {
  const pair = PARTICLES[form];
  if (!pair) return form;
  const t = String(prev).trim();
  const last = t.charCodeAt(t.length - 1);
  if (pair[0] === '으로' && last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 === 8) return '로';
  return hasJong(t) ? pair[0] : pair[1];
}

export function fill(s, vars) {
  let out = '', last = 0;
  const re = /\{(\w+)(?::([^}]+))?\}/g;
  let m;
  while ((m = re.exec(s))) {
    out += s.slice(last, m.index);
    last = m.index + m[0].length;
    if (!Object.prototype.hasOwnProperty.call(vars, m[1])) { out += m[0]; continue; }
    const v = String(vars[m[1]]);
    out += v;
    if (m[2]) out += particle(v || out, m[2]);
  }
  return out + s.slice(last);
}

// `load(tag)` imports a table relative to the page's own module, so each page
// keeps its tables next to it. A table that cannot be loaded leaves the page in
// zh-Hant, the language its static markup is written in.
export function createI18n({ base, load, label }) {
  let locale = 'zh-Hant';
  let dict = base;
  let plural = new Intl.PluralRules(locale);

  async function use(tag) {
    if (!tag) return;
    if (tag === 'zh-Hant') {
      dict = base; locale = tag; plural = new Intl.PluralRules(tag);
      return;
    }
    try {
      const mod = await load(tag);
      dict = mod.default; locale = tag; plural = new Intl.PluralRules(tag);
    } catch (err) {
      console.error(`${label} 載不到語言檔 ${tag}，留在繁體中文:`, err);
    }
  }

  function t(key, vars = null) {
    let v = dict[key];
    if (v === undefined) v = base[key];
    if (v === undefined) {
      console.warn(`${label} 語言檔缺 key: ${key}`);
      return key;
    }
    if (typeof v === 'object') {
      const n = Number(vars?.n);
      v = v[Number.isFinite(n) ? plural.select(n) : 'other'] ?? v.other;
    }
    return vars ? fill(v, vars) : v;
  }

  const has = key => dict[key] !== undefined || base[key] !== undefined;
  return { use, t, has, getLocale: () => locale };
}

// Static markup carries the zh-Hant text plus data-i18n hooks: data-i18n
// (text), data-i18n-html (our own inline markup), data-i18n-text (the
// element's own text nodes, "|"-separated keys, empty = leave that node) and
// data-i18n-attr ("attr:key;attr:key").
const ownTexts = el => [...el.childNodes].filter(n => n.nodeType === 3 && n.data.trim());

export function translateStatic(root, t) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-text]')) {
    const nodes = ownTexts(el);
    el.dataset.i18nText.split('|').forEach((key, i) => {
      if (!key || !nodes[i]) return;
      const lead = /^\s*/.exec(nodes[i].data)[0], trail = /\s*$/.exec(nodes[i].data)[0];
      nodes[i].data = lead + t(key) + trail;
    });
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const at = pair.indexOf(':');
      if (at > 0) el.setAttribute(pair.slice(0, at), t(pair.slice(at + 1)));
    }
  }
}

// Every key a static page asks for, for the key-parity tests.
export function pageKeys(html) {
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n-text="([^"]*)"/g)) for (const k of m[1].split('|')) if (k) keys.add(k);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const p of m[1].split(';')) keys.add(p.slice(p.indexOf(':') + 1));
  return keys;
}
