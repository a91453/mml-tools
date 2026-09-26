// Studio Workshop first paint (a classic script: Studio's CSP allows no inline
// script). Applies the stored theme before the page is drawn. The page is
// zh-Hant only.
(function () {
  var root = document.documentElement;
  var ui = {};
  try { ui = JSON.parse(localStorage.getItem("studio-workshop/ui") || "{}") || {}; } catch (e) { ui = {}; }
  var theme = ui.theme === "light" || ui.theme === "dark" ? ui.theme
    : (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  if (theme === "light") {
    root.setAttribute("data-theme", "light");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", "#f5f7f7");
  }
})();
