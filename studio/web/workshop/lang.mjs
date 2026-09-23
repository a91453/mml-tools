// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Language picker (client-side preference, reload with a local stash).
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { $ } from "./util.mjs";
import * as i18n from "./i18n.mjs";
import * as storage from "./storage.mjs";

const KEY = "studio-workshop/lang-handoff";

export const LANGS = ["zh-Hant", "en", "ja", "ko"];

const NAMES = {
  "zh-Hant": "繁體中文",
  "en":      "English",
  "ja":      "日本語",
  "ko":      "한국어",
};

function stash(snapshot) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ snapshot }));
  } catch (err) {
    console.warn("[Workshop] language switch stash failed:", err);
  }
}

export function takeHandoff() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch { return null; }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn("[Workshop] language switch stash unreadable:", err);
    return null;
  }
}

export function init(getSnapshot) {
  const sel = $("#lang");
  if (!sel) return;

  const cur = i18n.getLocale();
  sel.innerHTML = "";
  for (const [tag, name] of Object.entries(NAMES)) {
    const o = document.createElement("option");
    o.value = tag;
    o.textContent = name;
    if (tag === cur) o.selected = true;
    sel.appendChild(o);
  }

  sel.addEventListener("change", () => {
    const to = sel.value;
    if (to === cur) return;
    stash(getSnapshot());
    storage.saveUI({ lang: to });
    location.reload();
  });
}
