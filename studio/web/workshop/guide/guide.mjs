// Workshop help pages (studio/web/workshop/guide/). Ported from the owner's
// earlier frontend (owner-authorized port) and corrected against the current
// Workshop; the Workshop is outside the Canonical/verified pipeline.
//
// Each page is written in zh-Hant in its own HTML. The Workshop's boot.js has
// already chosen the language (the preference Studio and the Workshop share);
// for another language the article is replaced by that language's copy from
// ./i18n/<lang>.mjs and the page chrome is translated with the Workshop's own
// tables. Nothing here builds markup from user input: the articles are this
// site's static text.
import * as i18n from "../i18n.mjs";
import * as storage from "../storage.mjs";
import { LANGS, LANG_NAMES, translateStatic } from "../../i18n-core.mjs";

export const PAGES = ["editor", "reference", "keys", "mobile", "mml", "midi", "faq"];

const root = document.documentElement;
const page = document.body.dataset.guide;
const lang = LANGS.includes(root.lang) ? root.lang : "zh-Hant";

async function articleFor(tag) {
  if (tag === "zh-Hant") return null;
  try {
    const { default: pages } = await import(`./i18n/${tag}.mjs`);
    return typeof pages?.[page] === "string" ? pages[page] : null;
  } catch (err) {
    console.error(`[Workshop guide] 載不到 ${tag} 說明，留在繁體中文:`, err);
    return null;
  }
}

try {
  await i18n.use(lang);
  translateStatic(document, i18n.t);
  const html = await articleFor(lang);
  // Without that language's copy the article stays in zh-Hant, and says so.
  if (html) document.querySelector("#guide").innerHTML = html;
  else if (lang !== "zh-Hant") document.querySelector("#guide").lang = "zh-Hant";
  const h1 = document.querySelector("#guide h1");
  document.title = `${h1?.textContent ?? ""} · ${i18n.t("guide.site")}`;
  const current = document.querySelector(`.guide-nav a[href="./${page}.html"]`);
  current?.setAttribute("aria-current", "page");

  const select = document.querySelector("#guideLang");
  if (select) {
    for (const tag of LANGS) {
      const option = document.createElement("option");
      option.value = tag;
      option.textContent = LANG_NAMES[tag];
      option.selected = tag === lang;
      select.append(option);
    }
    select.addEventListener("change", () => {
      storage.saveUI({ lang: select.value });
      location.reload();
    });
  }
} finally {
  root.removeAttribute("data-i18n-pending");
}
