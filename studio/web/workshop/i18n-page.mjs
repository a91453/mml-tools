// Studio Workshop: translate the static page. The HTML carries the zh-Hant
// text plus data-i18n hooks: data-i18n (text), data-i18n-html (our own inline
// markup), data-i18n-text (the element's own text nodes, "|"-separated keys,
// empty = leave that node) and data-i18n-attr ("attr:key;attr:key").
import * as i18n from "./i18n.mjs";

const ownTexts = el => [...el.childNodes].filter(n => n.nodeType === 3 && n.data.trim());

export function translatePage(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = i18n.t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-html]")) el.innerHTML = i18n.t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll("[data-i18n-text]")) {
    const nodes = ownTexts(el);
    el.dataset.i18nText.split("|").forEach((key, i) => {
      if (!key || !nodes[i]) return;
      const lead = /^\s*/.exec(nodes[i].data)[0], trail = /\s*$/.exec(nodes[i].data)[0];
      nodes[i].data = lead + i18n.t(key) + trail;
    });
  }
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.dataset.i18nAttr.split(";")) {
      const at = pair.indexOf(":");
      if (at > 0) el.setAttribute(pair.slice(0, at), i18n.t(pair.slice(at + 1)));
    }
  }
  if (root === document) document.title = i18n.t("page.title");
}

// Every key the page asks for, for the key-parity test.
export function pageKeys(html) {
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n-text="([^"]*)"/g)) for (const k of m[1].split("|")) if (k) keys.add(k);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const p of m[1].split(";")) keys.add(p.slice(p.indexOf(":") + 1));
  return keys;
}
