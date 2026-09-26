// Workshop help pages, first paint (a classic script: the CSP allows no
// inline script). Applies the Workshop's theme from the preference Studio and
// the Workshop share (`studio-workshop/ui`), with the Workshop's own rule:
// dark unless light is chosen, or nothing is chosen and the system prefers
// light. The pages are zh-Hant only, whatever language the Workshop uses.
(function () {
  var ui = {};
  try { ui = JSON.parse(localStorage.getItem("studio-workshop/ui") || "{}") || {}; } catch (e) { ui = {}; }
  var theme = ui.theme === "light" || ui.theme === "dark" ? ui.theme
    : (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", "#f5f7f7");
  }
})();
