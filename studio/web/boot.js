// Studio main page first paint (a classic script: Studio's CSP allows no
// inline script). Applies the stored theme before the page is drawn. The
// preference is the one the Workshop shares (`studio-workshop/ui`); only its
// theme is read here. The Studio page is zh-Hant whatever language the
// Workshop stores.
(function () {
  var root = document.documentElement;
  var ui = {};
  try { ui = JSON.parse(localStorage.getItem("studio-workshop/ui") || "{}") || {}; } catch (e) { ui = {}; }
  var theme = ui.theme === "light" || ui.theme === "dark" ? ui.theme
    : (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.setAttribute("data-theme", theme);
  if (theme === "dark") {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", "#0b1a1f");
  }
})();
