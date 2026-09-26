// Workshop help pages (studio/web/workshop/guide/). Ported from the owner's
// earlier frontend (owner-authorized port) and corrected against the current
// Workshop; the Workshop is outside the Canonical/verified pipeline.
//
// The pages are written in zh-Hant only. When the Workshop is set to another
// language, the page still shows zh-Hant and its top line says so.
import * as storage from "../storage.mjs";

export const PAGES = ["editor", "reference", "keys", "mobile", "mml", "midi", "faq"];

const page = document.body.dataset.guide;
document.querySelector(`.guide-nav a[href="./${page}.html"]`)?.setAttribute("aria-current", "page");

const lang = storage.loadUI()?.lang;
const notice = document.querySelector("#zhOnly");
if (notice) notice.hidden = !lang || lang === "zh-Hant";
