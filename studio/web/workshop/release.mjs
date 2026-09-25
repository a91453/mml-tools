// Studio Workshop: new-release handling, through Studio Web's own update flow
// (../pwa-update.mjs). The earlier frontend offered this as the 「更新到新版」
// button (pwaUpdateBtn); Studio serves the Workshop cache-first from the same
// versioned cache as every other Studio page, so this page keeps running its
// release until it reloads and must be told when a newer one is waiting.
//
//   * offer: a downloaded release shows 「套用新版」. Applying it reloads this
//     tab only; other open Studio tabs mark themselves stale.
//   * stale: another tab applied a release. This page's loaded modules are the
//     old ones while the worker now serves the new ones, so anything that would
//     load or touch the new release — the WAV and video exporters, the .mxl
//     reader, Studio's own project database — is refused until a reload.
//
// A reload keeps what autosave keeps (flushed first). The caller's blocker
// names what it would lose otherwise — an export running, or edits that exist
// only in memory because autosave is off or cannot write — and the button
// then refuses instead of reloading.
import { createUpdateFlow } from "../pwa-update.mjs";
import * as i18n from "./i18n.mjs";
import * as storage from "./storage.mjs";
import { $, say } from "./util.mjs";

// Studio Web's worker and scope (the site root), exactly as Studio registers them.
const WORKER = "../../../sw.js";

let flow = null;
let leaving = false;
let blocker = () => null;

const btn = () => $("#pwaUpdate");

export const isStale = () => Boolean(flow?.stale);

// For an action that would load or touch the new release: refused, with the
// reason shown, while this page is stale.
export function blocked() {
  if (!isStale()) return false;
  say(i18n.t("pwa.stale"));
  return true;
}

function show(state) {
  const b = btn();
  if (!b) return;
  const stale = state === "stale";
  b.querySelector("span").textContent = i18n.t(stale ? "pwa.reloadBtn" : "pwa.updateBtn");
  b.title = i18n.t(stale ? "pwa.reloadBtnTitle" : "pwa.updateBtnTitle");
  b.hidden = false;
  b.disabled = false;
}

function onClick() {
  if (leaving || !flow) return;
  const why = blocker();
  if (why) { say(why); return; }
  storage.flush();
  if (flow.stale) {
    leaving = true;
    location.reload();
    return;
  }
  if (!flow.apply()) return;
  leaving = true;
  btn().disabled = true;
  say(i18n.t("pwa.applying"));
}

export function init({ leaveBlocker } = {}) {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  if (leaveBlocker) blocker = leaveBlocker;
  flow = createUpdateFlow({
    serviceWorker: navigator.serviceWorker,
    reload: () => location.reload(),
    onOffer: () => { show("offer"); say(i18n.t("pwa.offer")); },
    onStale: () => { storage.flush(); show("stale"); say(i18n.t("pwa.stale")); },
  });
  btn()?.addEventListener("click", onClick);
  const url = new URL(WORKER, location.href);
  navigator.serviceWorker.register(url, { scope: new URL("./", url).href }).then(reg => {
    flow.attach(reg);
    addEventListener("focus", () => flow.check());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flow.check(); });
  }).catch(err => console.warn("[Workshop] Service Worker 未註冊，這次沒有新版提示:", err));
}
