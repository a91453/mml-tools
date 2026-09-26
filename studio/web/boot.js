// Studio main page first paint (a classic script: Studio's CSP allows no
// inline script). Applies the stored theme and language before the page is
// drawn, from the preference the Workshop shares (`studio-workshop/ui`).
// A language other than zh-Hant keeps the body hidden until app.mjs has
// translated the static text (style.css: html[data-i18n-pending] body).
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
  var tags = ["zh-Hant", "en", "ja", "ko"];
  var lang = tags.indexOf(ui.lang) >= 0 ? ui.lang : null;
  if (!lang) {
    var wanted = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""]);
    for (var i = 0; i < wanted.length && !lang; i++) {
      var w = String(wanted[i]).toLowerCase();
      if (w.indexOf("zh") === 0) lang = "zh-Hant";
      else if (w.indexOf("ja") === 0) lang = "ja";
      else if (w.indexOf("ko") === 0) lang = "ko";
      else if (w.indexOf("en") === 0) lang = "en";
    }
  }
  lang = lang || "zh-Hant";
  root.setAttribute("lang", lang);
  if (lang !== "zh-Hant") root.setAttribute("data-i18n-pending", "");
})();
