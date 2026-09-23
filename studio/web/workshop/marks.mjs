// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Section marks.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { cleanMarks, MAX_MARKS } from "./config.mjs";

let list = [];

let onChange = () => {};

export const setChangeHandler = fn => { onChange = fn; };

export const stored = () => list;

export const isFull = () => list.length >= MAX_MARKS;

export const at = tick => list.find(m => m.tick === tick) ?? null;

export function set(next) {
  const clean = cleanMarks(next);
  if (same(clean, list)) return false;
  list = clean;
  onChange();
  return true;
}

const same = (a, b) =>
  a.length === b.length && a.every((m, i) => m.tick === b[i].tick && m.text === b[i].text);

export function put(tick, text) {
  if (isFull() && !at(tick)) return false;
  return set([...list.filter(m => m.tick !== tick), { tick, text }]);
}

export const remove = tick => set(list.filter(m => m.tick !== tick));

export function remap(at, delta) {
  if (!delta) return false;
  const gone = [at, at - delta];
  const map = t => {
    if (delta > 0) return t >= at ? t + delta : t;
    if (t >= gone[1]) return t + delta;
    return t > gone[0] ? gone[0] : t;
  };
  return set(list.map(m => ({ ...m, tick: map(m.tick) })));
}
