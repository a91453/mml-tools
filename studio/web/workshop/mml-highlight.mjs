// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Per-character MML syntax roles for the highlight layer.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { compact, scanTokens } from "./mml.mjs";
import { MAX_TRACK_CHARS } from "./config.mjs";

export const MAX_HL_CHARS = 8000;

const R = {
  plain: 0,
  t: 1,
  l: 2,
  o: 3,
  v: 4,
  n: 5,
  quiet: 6,
  punct: 7,
  dead: 8,
  bad: 9,
};
const CLS = ["", "tk-t", "tk-l", "tk-o", "tk-v", "tk-n",
             "tk-quiet", "tk-punct", "tk-dead", "tk-bad"];

const OVER = 1 << 4;
const SEL  = 1 << 5;

export function buildRoles(src, colors) {
  const n = src.length;
  const keys = new Uint8Array(n);

  if (colors && n > 0) {
    const { t, map } = compact(src);
    const inBody = new Uint8Array(n);
    for (const k of map) inBody[k] = 1;

    for (let k = 0; k < n; k++) {
      if (inBody[k]) continue;
      const c = src[k];
      if (c === " " || c === "\n" || c === "\t" || c === "\r") continue;
      keys[k] = c === "," || c === ";" ? R.punct : R.dead;
    }

    const put = (ca, cb, role) => { for (let k = ca; k < cb; k++) keys[map[k]] = role; };
    for (const tok of scanTokens(t)) {
      switch (tok.kind) {
        case "note":
          break;
        case "t": put(tok.a, tok.b, R.t); break;
        case "l": put(tok.a, tok.b, R.l); break;
        case "v": put(tok.a, tok.b, R.v); break;
        case "o": put(tok.a, tok.b, R.o); break;
        case "oct": put(tok.a, tok.b, R.o); break;
        case "tie": put(tok.a, tok.b, R.l); break;
        case "rest":
          put(tok.a, tok.a + 1, R.quiet);
          break;
        case "n": put(tok.a, tok.b, R.n); break;
        case "prog": put(tok.a, tok.b, R.quiet); break;
        case "bad":
          put(tok.a, tok.b, R.bad);
          break;
      }
    }

    if (map.length > MAX_TRACK_CHARS) {
      const from = map[MAX_TRACK_CHARS];
      const to = map[map.length - 1];
      for (let k = from; k <= to; k++) {
        if (inBody[k] || src[k] === " " || src[k] === "\n" || src[k] === "\t") keys[k] |= OVER;
      }
    }
  }

  return keys;
}

export function withSelection(base, ranges) {
  const keys = base.slice();
  const n = keys.length;
  for (const [a, b] of ranges) {
    for (let k = Math.max(0, a); k < Math.min(n, b); k++) keys[k] |= SEL;
  }
  return keys;
}

export function runAt(starts, end, i) {
  const at = Number.isFinite(i) ? Math.min(Math.max(0, i), end) : 0;
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid; else hi = mid - 1;
  }
  return { run: lo, offset: at - starts[lo] };
}

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function classOf(k) {
  let c = CLS[k & 15];
  if (k & OVER) c += " tk-over";
  if (k & SEL) c += " tk-sel";
  return c;
}

export function renderHTML(src, keys) {
  const n = src.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const k = keys[i];
    let j = i + 1;
    while (j < n && keys[j] === k) j++;
    const text = esc(src.slice(i, j));
    out += k === 0 ? text : `<span class="${classOf(k)}">${text}</span>`;
    i = j;
  }
  if (src === "" || src.endsWith("\n")) out += "\n ";
  return out;
}
