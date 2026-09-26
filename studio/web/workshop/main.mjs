// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Entry point: static text, editor wiring, then the sound engine.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { $, say } from "./util.mjs";
import * as i18n from "./i18n.mjs";
import { translatePage } from "./i18n-page.mjs";
import * as engine from "./engine.mjs";
import * as ui from "./ui.mjs";
import * as release from "./release.mjs";

translatePage(document);

$("#log button")?.addEventListener("click", () => { $("#log").style.display = "none"; });

ui.init();
release.init({ leaveBlocker: ui.leaveBlocker });

if (location.protocol === "file:" || location.origin === "null") {
  $("#engine").textContent = i18n.t("main.needHttp");
  $("#dlsName").textContent = i18n.t("main.unavailable");
  say(i18n.t("main.fileProtocol"));
} else {
  engine.boot().then(ui.loadStoredBank).catch(err => {
    console.error(err);
    $("#engine").textContent = i18n.t("main.engineFailed");
    say(ui.describe(err, i18n.t("main.engineDown")));
  });
}
