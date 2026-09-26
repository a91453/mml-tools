// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Flat-key i18n with zh-Hant fallback, plurals and Korean particles.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import zhHant from "./i18n/zh-Hant.mjs";

let locale = "zh-Hant";

let dict = zhHant;

const base = zhHant;

let plural = new Intl.PluralRules(locale);

export async function use(tag) {
  if (!tag) return;
  if (tag === "zh-Hant") {
    dict = zhHant;
    locale = tag;
    plural = new Intl.PluralRules(tag);
    return;
  }
  try {
    const mod = await import(`./i18n/${tag}.mjs`);
    dict = mod.default;
    locale = tag;
    plural = new Intl.PluralRules(tag);
  } catch (err) {
    console.error(`[Workshop] 載不到語言檔 ${tag}，留在繁體中文:`, err);
  }
}

export const getLocale = () => locale;

const PARTICLES = {
  "은": ["은", "는"], "는": ["은", "는"],
  "이": ["이", "가"], "가": ["이", "가"],
  "을": ["을", "를"], "를": ["을", "를"],
  "과": ["과", "와"], "와": ["과", "와"],
  "으로": ["으로", "로"], "로": ["으로", "로"],
  "이라": ["이라", "라"], "라": ["이라", "라"],
};
const DIGIT_JONG = { "0": 1, "1": 1, "3": 1, "6": 1, "7": 1, "8": 1, "2": 0, "4": 0, "5": 0, "9": 0 };

function hasJong(s) {
  const t = String(s).trim();
  if (!t) return false;
  const c = t[t.length - 1];
  if (c >= "0" && c <= "9") return !!DIGIT_JONG[c];
  const code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  return false;
}

function particle(prev, form) {
  const pair = PARTICLES[form];
  if (!pair) return form;
  const t = String(prev).trim();
  const last = t.charCodeAt(t.length - 1);
  if ((pair[0] === "으로") && last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 === 8)
    return "로";
  return hasJong(t) ? pair[0] : pair[1];
}

function fill(s, vars) {
  let out = "", last = 0;
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

export function t(key, vars = null) {
  let v = dict[key];
  if (v === undefined) v = base[key];
  if (v === undefined) {
    console.warn(`[Workshop] 語言檔缺 key: ${key}`);
    return key;
  }
  if (typeof v === "object") {
    const n = Number(vars?.n);
    v = v[Number.isFinite(n) ? plural.select(n) : "other"] ?? v.other;
  }
  return vars ? fill(v, vars) : v;
}

export const has = key => dict[key] !== undefined || base[key] !== undefined;

export const list   = items => items.join(t("list.item"));
export const clause = items => items.join(t("list.clause"));

export const trackName = i =>
  has(`track.name.${i}`) ? t(`track.name.${i}`) : t("track.nth", { n: i + 1 });

export const keySigLabel = i => t(`keysig.${i}`);
