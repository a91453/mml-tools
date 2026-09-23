// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Voice separation for MIDI import.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { CELL_TICKS, FINE_TICKS } from "./config.mjs";

const GRID = CELL_TICKS;

const endOf = n => Math.max(n.endTick, n.tick + GRID);

function avgPitch(frags) {
  let sum = 0, len = 0;
  for (const f of frags) { const d = f.to - f.from; sum += f.midi * d; len += d; }
  return len ? sum / len : (frags[0]?.midi ?? 0);
}

export function onsetGroups(notes) {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);

  const groups = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && n.tick - g.tick < FINE_TICKS) g.notes.push(n);
    else groups.push({ tick: n.tick, notes: [n] });
  }
  return groups;
}

export function mergeUnisons(notes) {
  const keep = new Map();
  for (const n of notes) {
    const k = `${n.tick}:${n.midi}`;
    const cur = keep.get(k);
    if (!cur || n.endTick - n.tick > cur.endTick - cur.tick) keep.set(k, n);
  }
  if (keep.size === notes.length) return notes;
  return [...keep.values()];
}

export function sample(notes, mode, { floor = GRID } = {}) {
  const groups = onsetGroups(notes);

  const picks = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    let best = g.notes[0];
    for (const n of g.notes)
      if (mode === "root" ? n.midi < best.midi : n.midi > best.midi) best = n;

    const own = Math.max(floor, best.endTick - best.tick);
    const next = groups[i + 1]?.tick;
    const dur = next === undefined ? own : Math.min(next - g.tick, own);
    picks.push({ tick: g.tick, midi: best.midi, vel: best.vel, dur, src: best });
  }
  return picks;
}

export const MELODY_MIN_RATIO = 0.25;

const MELODY_MIN_ONSETS = 20;

export function melodyRatio(notes) {
  if (!notes?.length) return 1;

  const src = [...notes].sort((a, b) => a.tick - b.tick || b.midi - a.midi);
  const byTick = new Map();
  for (const n of src) {
    if (!byTick.has(n.tick)) byTick.set(n.tick, []);
    byTick.get(n.tick).push(n);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);

  let lone = 0, idx = 0, live = [];
  for (const t of ticks) {
    while (idx < src.length && src[idx].tick <= t) live.push(src[idx++]);
    live = live.filter(n => endOf(n) > t);
    const starting = byTick.get(t);
    if (starting.length !== 1) continue;
    let top = -Infinity;
    for (const n of live) if (n.midi > top) top = n.midi;
    if (starting[0].midi >= top) lone++;
  }
  return lone / ticks.length;
}

export function melodyKind(notes) {
  if (!notes?.length) return "unknown";
  const onsets = new Set(notes.map(n => n.tick)).size;
  if (onsets < MELODY_MIN_ONSETS) return "unknown";
  return melodyRatio(notes) >= MELODY_MIN_RATIO ? "melody" : "chords";
}

export const hasMelody = notes => melodyKind(notes) !== "chords";

export function contigs(notes) {
  if (!notes?.length) return [];

  const src = [...notes].sort((a, b) => a.tick - b.tick || b.midi - a.midi);

  const times = new Set();
  for (const n of src) { times.add(n.tick); times.add(endOf(n)); }
  const ts = [...times].sort((a, b) => a - b);

  const slices = [];
  let idx = 0;
  let live = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    while (idx < src.length && src[idx].tick <= t0) live.push(src[idx++]);
    live = live.filter(n => endOf(n) > t0);
    if (!live.length) continue;
    slices.push({ from: t0, to: t1, notes: [...live].sort((a, b) => b.midi - a.midi) });
  }

  const out = [];
  for (const s of slices) {
    const last = out[out.length - 1];
    if (last && last.to === s.from && last.count === s.notes.length) {
      last.slices.push(s);
      last.to = s.to;
    } else {
      out.push({ from: s.from, to: s.to, count: s.notes.length, slices: [s] });
    }
  }
  return out;
}

export function strandsOf(contig) {
  const strands = Array.from({ length: contig.count }, () => []);
  for (const s of contig.slices) {
    for (let r = 0; r < contig.count; r++) {
      const n = s.notes[r];
      const st = strands[r];
      const last = st[st.length - 1];
      if (last && last.note === n && last.to === s.from) last.to = s.to;
      else st.push({ note: n, midi: n.midi, vel: n.vel, from: s.from, to: s.to });
    }
  }
  return strands;
}

export function reduceStrands(strands, cap, melody = true) {
  const k = strands.length;
  if (cap >= k) return strands;
  if (cap <= 0) return [];

  const anchors = [];
  for (const i of (melody ? [0, 1, k - 1] : [0, k - 1]))
    if (i >= 0 && i < k && !anchors.includes(i)) anchors.push(i);
  const keep = new Set(anchors.slice(0, cap));

  const lo = avgPitch(strands[k - 1]);
  const hi = avgPitch(strands[melody ? Math.min(1, k - 1) : 0]);
  const mid = (hi + lo) / 2;

  const rest = [];
  for (let i = 0; i < k; i++) if (!keep.has(i)) rest.push(i);
  rest.sort((a, b) => {
    const da = Math.abs(avgPitch(strands[a]) - mid);
    const db = Math.abs(avgPitch(strands[b]) - mid);
    return da - db || b - a;
  });
  for (const i of rest) {
    if (keep.size >= cap) break;
    keep.add(i);
  }

  return [...keep].sort((a, b) => a - b).map(i => strands[i]);
}

function hungarian(cost, nR, nC) {
  if (nR > nC) {
    const t = Array.from({ length: nC }, (_, j) =>
      Array.from({ length: nR }, (_, i) => cost[i][j]));
    const back = hungarian(t, nC, nR);
    const out = new Array(nR).fill(-1);
    for (let j = 0; j < nC; j++) if (back[j] >= 0) out[back[j]] = j;
    return out;
  }

  const n = nR, m = nC, INF = Infinity;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }

  const out = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] > 0) out[p[j] - 1] = j - 1;
  return out;
}

export function connect(prev, next) {
  const n = prev.length, m = next.length;
  const out = new Array(n).fill(-1);
  if (!n || !m) return out;

  const tail = st => st[st.length - 1];
  const head = st => st[0];

  const rows = [], taken = new Set();
  for (let i = 0; i < n; i++) {
    let hit = -1;
    for (let j = 0; j < m; j++) {
      if (taken.has(j)) continue;
      if (head(next[j]).note === tail(prev[i]).note) { hit = j; break; }
    }
    if (hit >= 0) { out[i] = hit; taken.add(hit); }
    else rows.push(i);
  }

  const cols = [];
  for (let j = 0; j < m; j++) if (!taken.has(j)) cols.push(j);
  if (!rows.length || !cols.length) return out;

  const cost = rows.map(i => cols.map(j =>
    Math.abs(tail(prev[i]).midi - head(next[j]).midi)));
  const match = hungarian(cost, rows.length, cols.length);
  for (let r = 0; r < rows.length; r++)
    if (match[r] >= 0) out[rows[r]] = cols[match[r]];
  return out;
}

export function separateVoices(notes, { cap = 4, melody = true } = {}) {
  const all = notes ?? [];
  if (!all.length || cap < 1)
    return { lanes: [], leftover: all.map(n => ({ ...n, src: n.src ?? n })), dropped: all.length };

  const segs = contigs(all);
  if (!segs.length)
    return { lanes: [], leftover: all.map(n => ({ ...n, src: n.src ?? n })), dropped: all.length };

  const reduced = segs.map(c => reduceStrands(strandsOf(c), cap, melody));
  const V = Math.max(...reduced.map(r => r.length));

  const width = Math.max(1, cap);
  const par = new Int32Array(segs.length * width);
  for (let i = 0; i < par.length; i++) par[i] = i;
  const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };

  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i].to !== segs[i + 1].from) continue;
    const m = connect(reduced[i], reduced[i + 1]);
    for (let s = 0; s < m.length; s++)
      if (m[s] >= 0) union(i * width + s, (i + 1) * width + m[s]);
  }

  const chains = new Map();
  for (let i = 0; i < segs.length; i++) {
    for (let s = 0; s < reduced[i].length; s++) {
      const root = find(i * width + s);
      let c = chains.get(root);
      if (!c) chains.set(root, c = { frags: [], from: Infinity, to: -Infinity });
      for (const f of reduced[i][s]) {
        c.frags.push(f);
        if (f.from < c.from) c.from = f.from;
        if (f.to > c.to) c.to = f.to;
      }
    }
  }

  const anchor = reduced.find(r => r.length === V) ?? [];
  const slots = Array.from({ length: V }, (_, k) => ({
    end: -Infinity,
    pitch: anchor[k] ? avgPitch(anchor[k]) : 0,
    frags: [],
  }));

  const list = [...chains.values()].sort((a, b) => a.from - b.from);
  const orphans = [];
  for (const c of list) {
    const p = avgPitch(c.frags);
    let best = -1, bestD = Infinity;
    for (let k = 0; k < slots.length; k++) {
      if (slots[k].end > c.from) continue;
      const d = Math.abs(slots[k].pitch - p);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) { orphans.push(c); continue; }
    slots[best].frags.push(...c.frags);
    slots[best].end = c.to;
    slots[best].pitch = p;
  }

  const byNote = new Map();
  slots.forEach((s, k) => {
    for (const f of s.frags) {
      if (!byNote.has(f.note)) byNote.set(f.note, []);
      byNote.get(f.note).push({ k, from: f.from, to: f.to });
    }
  });

  const laneNotes = slots.map(() => []);
  const leftover = [];
  const piece = (n, from, to) => ({ tick: from, endTick: to, midi: n.midi, vel: n.vel, src: n.src ?? n });

  for (const [note, fs] of byNote) {
    fs.sort((a, b) => a.from - b.from || a.k - b.k);
    const k = fs[0].k;
    let from = fs[0].from, to = fs[0].to;
    for (let x = 1; x < fs.length; x++)
      if (fs[x].k === k && fs[x].from === to) to = fs[x].to;

    laneNotes[k].push({ tick: from, midi: note.midi, vel: note.vel, dur: to - from, src: note.src ?? note });
    if (from > note.tick) leftover.push(piece(note, note.tick, from));
    if (to < endOf(note)) leftover.push(piece(note, to, endOf(note)));
  }

  for (const c of orphans)
    for (const f of c.frags)
      if (!byNote.has(f.note)) leftover.push(piece(f.note, f.from, f.to));

  let dropped = 0;
  for (const n of all) {
    if (byNote.has(n)) continue;
    dropped++;
    leftover.push(piece(n, n.tick, endOf(n)));
  }

  const lanes = laneNotes
    .filter(l => l.length)
    .map(l => l.sort((a, b) => a.tick - b.tick))
    .sort((a, b) => avg(b) - avg(a));

  leftover.sort((a, b) => a.tick - b.tick || b.midi - a.midi);
  return { lanes, leftover, dropped };
}

function avg(picks) {
  let sum = 0, len = 0;
  for (const p of picks) { sum += p.midi * p.dur; len += p.dur; }
  return len ? sum / len : 0;
}
