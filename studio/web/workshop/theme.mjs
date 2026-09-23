// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Dark/light theme switch.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import * as storage from "./storage.mjs";

export const DARK = "dark";
export const LIGHT = "light";

const BAR = { [DARK]: "#122325", [LIGHT]: "#f5f7f7" };

const listeners = new Set();

export const current = () =>
  document.documentElement.dataset.theme === LIGHT ? LIGHT : DARK;

export function apply(name) {
  const t = name === LIGHT ? LIGHT : DARK;
  const root = document.documentElement;
  if (t === LIGHT) root.dataset.theme = LIGHT;
  else delete root.dataset.theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = BAR[t];

  storage.saveUI({ theme: t });
  for (const fn of listeners) fn(t);
}

export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
