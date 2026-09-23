// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Selection model (marquee, ghost notes).
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
export function notesIn(track, start, end) {
  if (!track || end <= start) return [];
  return track.notes.filter(n => n.srcStart < end && n.srcEnd > start);
}

export const key = (tick, midi) => `${tick}:${midi}`;

export function rangeOf(track, picks) {
  if (!track || !picks?.length) return null;
  const want = new Set(picks.map(p => key(p.tick, p.midi)));
  let lo = Infinity, hi = -Infinity;
  for (const n of track.notes) {
    if (!want.has(key(n.tick, n.midi))) continue;
    if (n.srcStart < lo) lo = n.srcStart;
    if (n.srcEnd > hi) hi = n.srcEnd;
  }
  return lo <= hi ? [lo, hi] : null;
}

export function rangesOf(track, picks) {
  if (!track || !picks?.length) return [];
  const want = new Set(picks.map(p => key(p.tick, p.midi)));
  const spans = track.notes
    .filter(n => want.has(key(n.tick, n.midi)))
    .map(n => [n.srcStart, n.srcEnd])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const out = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function tickAt(track, index) {
  if (!track) return null;
  const ns = track.notes, rs = track.rests ?? [];
  let i = 0, j = 0;
  while (i < ns.length || j < rs.length) {
    const a = i < ns.length ? ns[i] : null;
    const b = j < rs.length ? rs[j] : null;
    const take = !b || (a && a.srcStart <= b.srcStart) ? a : b;
    if (take.srcEnd > index) return take.tick;
    if (take === a) i++; else j++;
  }
  return track.endTick;
}

export function ghostAt(tracks, { active, count, shown, rawTick, midi }) {
  if (!tracks) return null;
  const n = Math.min(count ?? tracks.length, tracks.length);
  for (let ch = 0; ch < n; ch++) {
    if (ch === active) continue;
    if (shown && shown[ch] === false) continue;
    const note = noteAt(tracks[ch], rawTick, midi);
    if (note) return { ch, note };
  }
  return null;
}

function noteAt(track, rawTick, midi) {
  const ns = track?.notes;
  if (!ns) return null;
  for (const n of ns) {
    if (n.tick > rawTick) break;
    if (n.midi === midi && rawTick < n.tick + n.durTick) return n;
  }
  return null;
}

let mir = null;
let mirSig = null;
let mirSrc = null;
let mirLine = 18;

const MIR_PROPS = ["fontFamily", "fontSize", "fontWeight", "fontStyle",
                   "letterSpacing", "lineHeight", "tabSize", "textIndent",
                   "whiteSpace", "overflowWrap", "wordBreak", "lineBreak",
                   "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
                   "width"];

function mirror(ta) {
  if (!mir) {
    mir = document.createElement("div");
    mir.setAttribute("aria-hidden", "true");
    Object.assign(mir.style, {
      position: "absolute", left: "-9999px", top: "0",
      visibility: "hidden", pointerEvents: "none",
      boxSizing: "content-box",
    });
    document.body.appendChild(mir);
  }
  const cs = getComputedStyle(ta);
  const sig = MIR_PROPS.map(p => cs[p]).join("\n");
  if (sig !== mirSig) {
    for (const p of MIR_PROPS) mir.style[p] = cs[p];
    mirSig = sig;
    mirLine = parseFloat(cs.lineHeight) || 18;
    mirSrc = null;
  }
  return mir;
}

function topOf(ta, index) {
  const m = mirror(ta);
  const src = ta.value;
  if (src !== mirSrc) { m.textContent = src + "\u200b"; mirSrc = src; }
  const node = m.firstChild;
  if (!node) return 0;
  const a = Math.min(Math.max(0, index), node.data.length - 1);
  const r = document.createRange();
  r.setStart(node, a);
  r.setEnd(node, a + 1);
  return r.getBoundingClientRect().top - m.getBoundingClientRect().top;
}

export function reveal(ta, index) {
  if (!ta) return;
  const top = topOf(ta, index);
  const lh = mirLine;
  const view = ta.clientHeight;
  if (top >= ta.scrollTop + lh && top + lh <= ta.scrollTop + view - lh) return;
  ta.scrollTop = Math.max(0, top - view / 3);
}
