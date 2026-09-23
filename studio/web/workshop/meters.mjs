// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Meter (time signature) map state.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { cleanMeters, setMeters as applyToBarMap, DEFAULT_METER } from "./config.mjs";
import * as storage from "./storage.mjs";

let list = cleanMeters([]);

let on = storage.loadUI()?.timeSig === true;

let onChange = () => {};

export const setChangeHandler = fn => { onChange = fn; };

function apply() { applyToBarMap(on ? list : []); }
apply();

export const stored = () => list;

export const isPlain = () =>
  list.length === 1 && list[0].num === DEFAULT_METER.num && list[0].den === DEFAULT_METER.den;

export function set(next) {
  const clean = cleanMeters(next);
  if (same(clean, list)) return false;
  list = clean;
  apply();
  onChange();
  return true;
}

const same = (a, b) =>
  a.length === b.length &&
  a.every((m, i) => m.tick === b[i].tick && m.num === b[i].num && m.den === b[i].den);

export function remap(at, delta) {
  if (!delta) return false;
  const gone = [at, at - delta];
  const map = t => {
    if (t === 0) return 0;
    if (delta > 0) return t >= at ? t + delta : t;
    if (t >= gone[1]) return t + delta;
    return t > gone[0] ? gone[0] : t;
  };
  return set(list.map(m => ({ ...m, tick: map(m.tick) })));
}

export const isOn = () => on;

export function setOn(next) {
  const v = !!next;
  if (v === on) return false;
  on = v;
  storage.saveUI({ timeSig: on });
  apply();
  onChange();
  return true;
}
