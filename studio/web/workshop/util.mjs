// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// DOM and file-name helpers.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
export const $ = s => document.querySelector(s);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const shiftIndex = (idx, from, to) =>
  idx === from ? to
  : from < idx && idx <= to ? idx - 1
  : to <= idx && idx < from ? idx + 1
  : idx;

export const slotToIndex = (from, slot) => (slot > from ? slot - 1 : slot);

export function gridSlotAt(x, y, rects) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return -1;
  const r = rects[best];
  return x < r.left + r.width / 2 ? best : best + 1;
}

export const indexAfterRemove = (idx, removed, count) =>
  idx > removed ? idx - 1 : Math.min(idx, Math.max(0, count - 1));

export const DEFAULT_NAME = "score";

// Every extension the import dialog reads, so an imported file's name becomes
// the song name without it (score.mxl → score.mid, not score.mxl.mid).
const EXT = /\.(mml|mmi|mid|midi|txt|mxl|musicxml|xml)$/i;

export const stripExt = name => String(name ?? "").replace(EXT, "");

export function safeFileName(input) {
  const bad = new RegExp("[\\\\/:*?\"<>|\\u0000-\\u001f]", "g");
  const s = stripExt(String(input ?? "").trim())
    .replace(bad, "")
    .replace(/[. ]+$/, "")
    .trim();
  return s || DEFAULT_NAME;
}

export function say(html) {
  $("#logMsg").innerHTML = html;
  $("#log").style.display = "block";
}
