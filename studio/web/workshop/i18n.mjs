// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Flat-key text table, zh-Hant only (the owner is the only user). Keeping the
// strings in one table keeps the static page and the modules in step.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import zhHant from "./i18n/zh-Hant.mjs";

const dict = zhHant;

export const getLocale = () => "zh-Hant";

function fill(s, vars) {
  return s.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

export function t(key, vars = null) {
  const v = dict[key];
  if (v === undefined) {
    console.warn(`[Workshop] 文字表缺 key: ${key}`);
    return key;
  }
  return vars ? fill(v, vars) : v;
}

export const has = key => dict[key] !== undefined;

export const list   = items => items.join(t("list.item"));
export const clause = items => items.join(t("list.clause"));

export const trackName = i =>
  has(`track.name.${i}`) ? t(`track.name.${i}`) : t("track.nth", { n: i + 1 });

export const keySigLabel = i => t(`keysig.${i}`);
