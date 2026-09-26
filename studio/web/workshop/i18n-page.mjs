// Studio Workshop: translate the static page. The hooks (data-i18n,
// data-i18n-html, data-i18n-text, data-i18n-attr) are described in
// ../i18n-core.mjs, which the Studio main page shares.
import * as i18n from "./i18n.mjs";
import { pageKeys, translateStatic } from "../i18n-core.mjs";

export function translatePage(root = document) {
  translateStatic(root, i18n.t);
  if (root === document) document.title = i18n.t("page.title");
}

export { pageKeys };
