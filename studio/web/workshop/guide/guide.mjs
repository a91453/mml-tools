// Workshop help pages (studio/web/workshop/guide/). Ported from the owner's
// earlier frontend (owner-authorized port) and corrected against the current
// Workshop; the Workshop is outside the Canonical/verified pipeline.
// The pages are zh-Hant only, like the Workshop itself.

export const PAGES = ["editor", "reference", "keys", "mobile", "mml", "midi", "faq"];

const page = document.body.dataset.guide;
const here = document.querySelector(`.guide-nav a[href="./${page}.html"]`);
here?.setAttribute("aria-current", "page");
// On a phone the page list is one sideways-scrolling row: bring this page's
// entry into the middle of it.
if (here) {
  const nav = here.parentElement;
  nav.scrollLeft += here.getBoundingClientRect().left - nav.getBoundingClientRect().left - (nav.clientWidth - here.offsetWidth) / 2;
}

// The table of contents is open in the markup, so it is there without this
// script. A narrow screen folds it to its one "本頁目錄" line; a wide one keeps
// it open beside the article (guide.css), where its summary cannot be clicked.
const toc = document.querySelector("#guide > details.toc");
const wide = matchMedia("(min-width: 1140px)");
const fit = () => {
  if (!toc) return;
  toc.open = wide.matches;
  // Nothing to toggle beside the article, so the summary leaves the tab order too.
  toc.querySelector("summary").tabIndex = wide.matches ? -1 : 0;
};
fit();
wide.addEventListener("change", fit);
toc?.addEventListener("toggle", () => { if (wide.matches && !toc.open) toc.open = true; });

// Mark the section being read: the last heading the contents list names that
// has scrolled to the top of the window.
if (toc) {
  const entries = [...toc.querySelectorAll('a[href^="#"]')]
    .map(link => [link, document.getElementById(decodeURIComponent(link.hash.slice(1)))])
    .filter(([, heading]) => heading);
  let queued = false;
  const mark = () => {
    queued = false;
    let current = null;
    for (const [link, heading] of entries) if (heading.getBoundingClientRect().top <= 80) current = link;
    for (const [link] of entries) {
      if (link === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(mark); } }, { passive: true });
  mark();
}
