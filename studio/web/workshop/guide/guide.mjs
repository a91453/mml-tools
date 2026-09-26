// Workshop help pages (studio/web/workshop/guide/). Ported from the owner's
// earlier frontend (owner-authorized port) and corrected against the current
// Workshop; the Workshop is outside the Canonical/verified pipeline.
// The pages are zh-Hant only, like the Workshop itself.

export const PAGES = ["editor", "reference", "keys", "mobile", "mml", "midi", "faq"];

const page = document.body.dataset.guide;
document.querySelector(`.guide-nav a[href="./${page}.html"]`)?.setAttribute("aria-current", "page");
