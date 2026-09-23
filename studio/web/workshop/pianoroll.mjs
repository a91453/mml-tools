// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Piano roll canvas: viewport, drawing, gestures.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import {
  PITCH_MIN, PITCH_MAX, PITCH_ROWS, ROLL_MAX, playable, soundsAsWritten,
  GAME_MIN, GAME_MAX, OCT_BASE,
  CELL_TICKS, FINE_TICKS,
  CELL_W as CELL_W0, ROW_H as ROW_H0,
  GUTTER_W, RULER_H,
  TRACK_COLORS, MAX_TRACKS, GAME_TRACKS,
  midiToRow, tickToPx, pxToTick, barsFor,
  PPQ, barIndexOf, barStartTick, barTicksAt, meterAt, meterName, meters, contentTicks,
  ZOOM_W, ZOOM_H, zoomStep, zoomScroll, gridStep, rowLinesAt,
  PINCH_SPAN, pinchAxis, zoomTick,
} from "./config.mjs";
import { makeClock, makeInverseClock, lenTicks, tempoChanges, velChanges } from "./mml.mjs";
import { snapDown, overwriteEffect } from "./rolledit.mjs";
import { ghostAt } from "./select.mjs";
import { say, clamp } from "./util.mjs";
import * as player from "./player.mjs";
import * as rolljoy from "./rolljoy.mjs";
import * as i18n from "./i18n.mjs";
import * as theme from "./theme.mjs";

const C = {
  bg:        "#0d1a1b",
  rowWhite:  "#12201f",
  rowBlack:  "#0b1516",
  rowKeyIn:  "#070d0e",
  rowKeyOff: "#2c3937",
  dimRow:    "rgba(6,12,13,.34)",
  dimKey:    "rgba(6,12,13,.55)",
  gridHalf:  "rgba(35,64,63,.18)",
  gridCell:  "rgba(35,64,63,.35)",
  gridBeat:  "rgba(35,64,63,.75)",
  gridBar:   "rgba(87,182,164,.30)",
  gridOct:   "rgba(87,182,164,.16)",
  gridEdge:  "rgba(176,192,189,.55)",
  gutterBg:  "#16292b",
  keyWhite:  "#c9d8d5",
  keyBlack:  "#1a3032",
  keyLabel:  "#0d1a1b",
  rulerBg:   "#122325",
  line:      "#23403f",
  dim:       "#7f9b98",
  dimmer:    "#547370",
  guide:     "#e0ae5a",
  activeEdge: "#ffffff",
  selEdge:   "#ffffff",
  hover:     "rgba(255,255,255,.6)",
  markStart: "#8ecdf5",
  markEnd:   "#f2a0bb",
  markHover: "rgba(255,255,255,.45)",
  marquee:   "rgba(126,214,223,.16)",
  marqueeEdge: "rgba(168,235,240,.9)",
  caret:     "rgba(200,214,211,.55)",
  tempo:     "#57b6a4",
  vel:       "#e08b4a",
  bad:       "#ff3b30",
  badBar:    "rgba(255,59,48,.16)",
  willKill:  "#ff3b30",
  willTrim:  "#e0ae5a",
};

export function readTheme(root = document.documentElement) {
  if (typeof getComputedStyle !== "function") return;
  const cs = getComputedStyle(root);
  const ga = parseFloat(cs.getPropertyValue("--roll-ghost-alpha"));
  ghostAlpha = Number.isFinite(ga) && ga > 0 ? ga : GHOST_ALPHA;
  const aa = parseFloat(cs.getPropertyValue("--roll-aux-alpha"));
  auxAlpha = Number.isFinite(aa) && aa > 0 ? aa : AUX_ALPHA;
  const gf = parseFloat(cs.getPropertyValue("--roll-ghost-fill-alpha"));
  ghostFillAlpha = Number.isFinite(gf) && gf > 0 ? gf : GHOST_FILL_ALPHA;
  const es = parseFloat(cs.getPropertyValue("--roll-note-edge-shade"));
  noteEdgeShade = Number.isFinite(es) && es > 0 ? es : 0;
  for (const k of Object.keys(C)) {
    const v = cs.getPropertyValue("--roll-" + k.replace(/[A-Z]/g, c => "-" + c.toLowerCase())).trim();
    if (v) C[k] = v;
  }
}

const ACTIVE_ALPHA = 0.9;
const GHOST_ALPHA  = 0.6;
const AUX_ALPHA = 0.28;

const GHOST_FILL_ALPHA = 0.06;

let ghostAlpha = GHOST_ALPHA;
let auxAlpha = AUX_ALPHA;

let ghostFillAlpha = GHOST_FILL_ALPHA;

let noteEdgeShade = 0;

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const dim = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const f = c => Math.round(c * k);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
};

let cv = null, g = null, pad = null, box = null;
let song = null;
let active = 0;
let trackCount = () => MAX_TRACKS;
let getGhosts = () => [];
let onPick = () => {};
let onAdd = () => false;
let onDelete = () => false;
let onMove = () => false;
let onAudition = () => {};
let onAuditionEnd = () => {};
let onAuditionNote = () => {};
let onPlayItem = () => {};
let onRange = () => {};
let onRangePick = () => {};
let onTogglePick = () => {};
let onSetPicks = () => {};
let onPickGhost = () => {};
let onDeleteSel = () => {};
let onRollMenu = () => {};
let onNoteMenu = () => {};
let onMeterMenu = () => {};
let onView = () => {};

let markLines = [];
let onBarMenu = () => {};

let timeSigUI = false;
let onJumpText = () => {};
let editable = true;
let badKeys = new Set();
let badBars = new Set();
let badNote = "";
let whyNot = "";
let nonstdN = 0;
let onNonstdFix = null;
let nonstdZip = false;

let hover = null;

let hoverPt = null;

let drag = null;

let pend = null;

const RESIZE_ZONE = 5;

const TAP_SLOP = 8;
const LONG_MS = 400;

const MARQUEE_SLOP = 4;

const EDGE_ZONE = 40;
const EDGE_MAX = 1000;

const touchPts = new Map();

let gesture = null;

let multiPick = false;

let ghostSwitchAt = -Infinity;

const GHOST_DBL_MS = 600;

let padCur = null;
let onCopy = () => "";
let onPaste = () => {};
let onVelocity = () => {};
let onSelectAll = () => {};
let onDuplicate = () => {};
let isLaneArea = () => false;

let CELL_W = CELL_W0, ROW_H = ROW_H0;

let noteLen = 32;

let noteDot = false;

let tool = "select";

const snapDraw = (e) => {
  if (tool !== "draw") return CELL_TICKS;
  if (e?.pointerType === "touch") return Math.min(lenTicks(noteLen, 0), PPQ);
  return noteLen === 64 ? FINE_TICKS : CELL_TICKS;
};

const snapMove = () => (tool === "draw" && noteLen === 64 ? FINE_TICKS : CELL_TICKS);

const drawLen = () => lenTicks(noteLen, noteDot ? 1 : 0);

let selection = [];
let selKeys = new Set();

const selKey = (tick, midi) => `${tick}:${midi}`;

export function setSelection(list) {
  selection = Array.isArray(list) ? list : [];
  selKeys = new Set(selection.map(n => selKey(n.tick, n.midi)));
  syncJoy();
  draw();
}

export const selectedNotes = () => selection;

let caret = null;

export function setCaret(tick) {
  const t = Number.isFinite(tick) ? tick : null;
  if (t === caret) return;
  caret = t;
  draw();
}
let markStart = null;
let markEnd = null;

let markCursor = null;

let anchor = null;

let audition = null;

let keyPcs = null;

export function setKey(pcs) {
  keyPcs = pcs instanceof Set && pcs.size ? pcs : null;
  draw();
}

let invClock = null;
let guideFloor = null;
let follow = true;
let expectScrollLeft = 0;
let centered = false;
let rafOn = false;

const bars = () => barsFor(songEndTick());

const contentW = () => tickToPx(contentTicks(songEndTick()), CELL_W);
const contentH = () => PITCH_ROWS * ROW_H;

const scrollX = () => box.scrollLeft;
const scrollY = () => box.scrollTop;

const tickToX = tick => GUTTER_W + tickToPx(tick, CELL_W) - scrollX();
const xToTick = x => pxToTick(x - GUTTER_W + scrollX(), CELL_W);

const midiToY = midi => RULER_H + midiToRow(midi) * ROW_H - scrollY();
const yToMidi = y => ROLL_MAX - Math.floor((y - RULER_H + scrollY()) / ROW_H);

// Canvas-relative centre of the cell at (tick, midi), for pointer-driven checks
// (studio/browser-tests/workshop.mjs) and anything that needs to aim at a note.
export const pointFor = (tick, midi) => ({ x: tickToX(tick) + CELL_W / 2, y: midiToY(midi) + ROW_H / 2 });

export function init({ canvas, padEl, scroller, getTrackCount, getGhostFlags,
                       onPickNote, onAddNote, onDeleteNote, onMoveNote,
                       onAudition: audOn, onAuditionEnd: audOff, onAuditionNote: audNote,
                       onPlayItem: playItem, onRangeChange, onRangePick: rangePick,
                       onTogglePick: togglePick, onSetPicks: setPicks,
                       onPickGhost: pickGhost,
                       onDeleteSelection: delSel,
                       onCopySelection: copySel, onPasteAt: pasteTo, onVelocity: velNudge,
                       onSelectAll: selAll, onDuplicate: dupSel, isLaneArea: laneArea,
                       onContextMenu: rollMenu, onNoteMenu: noteMenu, onMeterMenu: meterMenu,
                       onViewChange: viewChange,
                       onBarMenu: barMenu,
                       onJumpText: jumpText,
                       onNonstdFix: nonstdFix } = {}) {
  cv = canvas; pad = padEl; box = scroller;
  g = cv.getContext("2d");
  readTheme();
  theme.onChange(() => { readTheme(); draw(); });
  trackCount = getTrackCount ?? trackCount;
  getGhosts = getGhostFlags ?? getGhosts;
  onNonstdFix = nonstdFix ?? onNonstdFix;
  onPick = onPickNote ?? onPick;
  onAdd = onAddNote ?? onAdd;
  onDelete = onDeleteNote ?? onDelete;
  onMove = onMoveNote ?? onMove;
  onAudition = audOn ?? onAudition;
  onAuditionEnd = audOff ?? onAuditionEnd;
  onAuditionNote = audNote ?? onAuditionNote;
  onPlayItem = playItem ?? onPlayItem;
  onRange = onRangeChange ?? onRange;
  onRangePick = rangePick ?? onRangePick;
  onTogglePick = togglePick ?? onTogglePick;
  onSetPicks = setPicks ?? onSetPicks;
  onPickGhost = pickGhost ?? onPickGhost;
  onDeleteSel = delSel ?? onDeleteSel;
  onCopy = copySel ?? onCopy;
  onPaste = pasteTo ?? onPaste;
  onVelocity = velNudge ?? onVelocity;
  onSelectAll = selAll ?? onSelectAll;
  onDuplicate = dupSel ?? onDuplicate;
  isLaneArea = laneArea ?? isLaneArea;
  onRollMenu = rollMenu ?? onRollMenu;
  onNoteMenu = noteMenu ?? onNoteMenu;
  onMeterMenu = meterMenu ?? onMeterMenu;
  onView = viewChange ?? onView;
  onBarMenu = barMenu ?? onBarMenu;
  onJumpText = jumpText ?? onJumpText;

  box.addEventListener("scroll", () => {
    if (Math.abs(box.scrollLeft - expectScrollLeft) > 1) setFollow(false);
    expectScrollLeft = box.scrollLeft;
    if (rafOn) return;
    draw();
  }, { passive: true });

  new ResizeObserver(() => { resize(); draw(); }).observe(box);
  box.addEventListener("wheel", onWheel, { passive: false });

  for (const t of ["gesturestart", "gesturechange", "gestureend"])
    box.addEventListener(t, e => e.preventDefault(), { passive: false });
  cv.addEventListener("pointerdown", onPointerDown);
  cv.addEventListener("pointermove", onPointerMove);
  cv.addEventListener("pointerup", e => onPointerUp(e, true));
  cv.addEventListener("pointercancel", e => onPointerUp(e, false));
  cv.addEventListener("lostpointercapture", endAudition);
  cv.addEventListener("pointerleave", () => {
    endAudition();
    hoverPt = null;
    if (drag) return;
    if (hover || markCursor !== null) { hover = null; markCursor = null; draw(); }
  });
  addEventListener("pointermove", e => {
    if (!lastDownTouch) return;
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    lastDownTouch = false;
    syncToolbar();
  }, { capture: true, passive: true });

  addEventListener("focusin", () => syncJoy());
  addEventListener("focusout", () => setTimeout(syncJoy, 0));

  cv.addEventListener("contextmenu", onContextMenu);
  addEventListener("contextmenu", e => {
    if (!lastDownTouch || editing(e.target)) return;
    e.preventDefault();
  }, { capture: true });
  cv.addEventListener("dblclick", onDoubleClick);
  addEventListener("keydown", e => {
    if (e.key === "Escape") {
      endAudition();
      if (pend) {
        try { cv.releasePointerCapture(pend.pid); } catch {  }
        pend = null;
        return;
      }
      if (drag) { endDrag(false); return; }
      if (!editing(e.target) && !document.querySelector(MODAL_SEL)
          && selection.length) {
        multiPick = false;
        onPick(null);
        draw();
      }
      return;
    }
    if (document.querySelector(MODAL_SEL)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (editing(e.target) || drag || !canEdit() || !selection.length) return;
      e.preventDefault(); onDeleteSel(selection); return;
    }
    if ((e.key === "+" || e.key === "-") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (editing(e.target) || drag || !canEdit() || !selection.length) return;
      e.preventDefault(); onVelocity(e.key === "+" ? 1 : -1); return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && (e.key === "a" || e.key === "A")) {
      if (editing(e.target) || drag) return;
      e.preventDefault();
      onSelectAll();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && (e.key === "d" || e.key === "D")) {
      if (editing(e.target) && !isLaneArea(e.target)) return;
      e.preventDefault();
      if (e.repeat || drag || !canEdit()) return;
      const at = dupTick();
      if (at !== null) onDuplicate(at);
      return;
    }

    if (e.key === "." && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      if (editing(e.target)) return;
      if (drag) return;
      e.preventDefault();
      toggleNoteDot();
      return;
    }

    if (!drag || e.ctrlKey || e.altKey || e.metaKey) return;
    if (nudge(e.key, e.shiftKey)) e.preventDefault();
  });

  rolljoy.init({
    onStep: padStep,
    onStepEnd: padStepEnd,
    onStart: padStart,
    onMove: padMove,
    onEnd: padEnd,
    onMenu: openSelMenu,
    onMulti: on => { multiPick = on; syncToolbar(); },
    onDelete: () => {
      if (drag || !canEdit() || !selection.length) return;
      onDeleteSel(selection.map(n => ({ tick: n.tick, midi: n.midi })));
    },
    onClear: () => { if (!drag) { multiPick = false; onPick(null); draw(); } },
  });

  initClipboard();
  initToolbar();
  resize();
}

export function resize() {
  if (!cv) return;
  const w = Math.max(1, box.clientWidth), h = Math.max(1, box.clientHeight);
  const d = devicePixelRatio || 1;
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  cv.width = Math.round(w * d);
  cv.height = Math.round(h * d);
  g.setTransform(d, 0, 0, d, 0, 0);
  syncPad();
  rolljoy.place();
}

function syncPad() {
  if (!pad) return;
  pad.style.width = (GUTTER_W + contentW()) + "px";
  pad.style.height = (RULER_H + contentH()) + "px";
}

export function setZoom({ w, h, anchor } = {}) {
  const nw = ZOOM_W.includes(w) ? w : CELL_W;
  const nh = ZOOM_H.includes(h) ? h : ROW_H;
  if (nw === CELL_W && nh === ROW_H) return false;
  if (!box) { CELL_W = nw; ROW_H = nh; return true; }

  const W = box.clientWidth, H = box.clientHeight;
  const ax = clamp(anchor ? anchor.x : GUTTER_W + (W - GUTTER_W) / 2, GUTTER_W, W) - GUTTER_W;
  const ay = clamp(anchor ? anchor.y : RULER_H + (H - RULER_H) / 2, RULER_H, H) - RULER_H;
  const sx = zoomScroll(scrollX(), ax, CELL_W, nw);
  const sy = zoomScroll(scrollY(), ay, ROW_H, nh);

  CELL_W = nw; ROW_H = nh;
  syncPad();
  box.scrollLeft = sx;
  box.scrollTop  = sy;
  expectScrollLeft = box.scrollLeft;
  syncToolbar();
  draw();
  return true;
}

function stepZoom(axis, dir, anchor) {
  const steps = axis === "w" ? ZOOM_W : ZOOM_H;
  const next = zoomStep(steps, axis === "w" ? CELL_W : ROW_H, dir);
  return next === null ? false : setZoom({ [axis]: next, anchor });
}

function dupTick() {
  const notes = song?.tracks[active]?.notes ?? [];
  const sel = notes.filter(n => selKeys.has(selKey(n.tick, n.midi)));
  if (!sel.length) return null;

  const start = Math.min(...sel.map(n => n.tick));
  const span = Math.max(1, Math.max(...sel.map(n => n.tick + n.durTick)) - start);
  const n0 = barIndexOf(start);
  const from = barStartTick(n0);
  let k = 1;
  while (k < 4096 && barStartTick(n0 + k) - from < span) k++;
  return start + (barStartTick(n0 + k) - from);
}

function initClipboard() {
  const blocked = e => editing(e.target) || !!document.querySelector(MODAL_SEL) || !!drag;

  const pasteTick = () => {
    if (selection.length) return Math.min(...selection.map(n => n.tick));
    if (hoverPt) return markTickRaw(hoverPt);
    return markStart;
  };
  addEventListener("copy", e => {
    if (blocked(e) || !selection.length) return;
    const text = onCopy();
    if (!text) return;
    e.clipboardData.setData("text/plain", text); e.preventDefault();
  });
  addEventListener("cut", e => {
    if (blocked(e) || !canEdit() || !selection.length) return;
    const text = onCopy();
    if (!text) return;
    e.clipboardData.setData("text/plain", text); e.preventDefault();
    onDeleteSel(selection);
  });
  addEventListener("paste", e => {
    if (blocked(e) || !canEdit()) return;
    const at = pasteTick();
    if (at === null || at === undefined) { say(i18n.t("roll.paste.noWhere")); return; }
    const text = e.clipboardData?.getData("text/plain");
    if (!text?.trim()) return;
    e.preventDefault(); onPaste(at, text);
  });
}

const MODAL_SEL = ".modal.on, #rollMenu, .drawer.on";

const WHEEL_STEP = 100;
let wheelAcc = 0, wheelAxis = null;

function onWheel(e) {
  const zoomKey = e.ctrlKey || e.metaKey;
  const axis = zoomKey && e.shiftKey ? "h"
    : e.altKey && !zoomKey ? "h"
      : zoomKey ? "w"
        : null;

  if (axis === null) return;
  e.preventDefault();

  const px = e.deltaMode === 1 ? e.deltaY * 16
    : e.deltaMode === 2 ? e.deltaY * box.clientHeight
      : e.deltaY;

  if (axis !== wheelAxis || Math.sign(px) !== Math.sign(wheelAcc)) wheelAcc = 0;
  wheelAxis = axis;
  wheelAcc += px;

  const dir = px < 0 ? 1 : -1;
  const r = cv.getBoundingClientRect();
  const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
  while (Math.abs(wheelAcc) >= WHEEL_STEP) {
    wheelAcc -= Math.sign(wheelAcc) * WHEEL_STEP;
    if (!stepZoom(axis, dir, anchor)) {
      wheelAcc = 0;
      break;
    }
  }
}

export function setSong(parsed) {
  song = parsed;
  syncPad();
  if (!centered && song && song.tracks.some(t => t.notes.length)) { centered = true; centerOnNotes(); }
  draw();
}

export function setActive(i) {
  if (i === active) return;
  active = i;
  selection = []; selKeys = new Set();
  anchor = null;
  lastPlayKey = null;
  hover = null;
  drag = null;
  syncToolbar();
  draw();
}

export function reveal(tick, midi = null) {
  if (!box) return;
  const W = box.clientWidth, H = box.clientHeight;
  const mx = CELL_W * 4, my = ROW_H * 4;
  let dx = 0, dy = 0;

  const x = tickToX(tick);
  if (x < GUTTER_W + mx) dx = x - (GUTTER_W + mx);
  else if (x > W - mx) dx = x - (W - mx);

  if (midi !== null) {
    const y = midiToY(midi);
    if (y < RULER_H + my) dy = y - (RULER_H + my);
    else if (y + ROW_H > H - my) dy = y + ROW_H - (H - my);
  }

  if (!dx && !dy) return;
  const maxX = Math.max(0, GUTTER_W + contentW() - W);
  const maxY = Math.max(0, RULER_H + contentH() - H);
  const nx = Math.min(maxX, Math.max(0, box.scrollLeft + dx));
  expectScrollLeft = nx;
  box.scrollLeft = nx;
  box.scrollTop = Math.min(maxY, Math.max(0, box.scrollTop + dy));
}

function centerOnNotes() {
  const all = song.tracks.flatMap(t => t.notes.map(n => n.midi));
  if (!all.length) return;
  const mid = (Math.min(...all) + Math.max(...all)) / 2;
  const y = midiToRow(mid) * ROW_H - (box.clientHeight - RULER_H) / 2;
  box.scrollTop = Math.max(0, Math.min(y, RULER_H + contentH() - box.clientHeight));
}

function rebuildInvClock() {
  const s = player.state().song;
  invClock = s ? makeInverseClock(s.tempos) : null;
}

export function kick() {
  rebuildInvClock();
  setFollow(true);
  hover = null;
  markCursor = null;
  drag = null;
  endAudition();
  startRaf();
}

export function wake() {
  rebuildInvClock();
  syncToolbar();
  startRaf();
}

export function setGuideFloor(tick) {
  const t = Number.isFinite(tick) ? tick : null;
  if (t === guideFloor) return;
  guideFloor = t;
  syncToolbar();
  draw();
}

export function stop() {
  invClock = null;
  guideFloor = null;
  lastPlayKey = null;
  syncToolbar();
  draw();
}

function startRaf() {
  if (rafOn) return;
  rafOn = true;
  requestAnimationFrame(function loop() {
    const { playing, paused } = player.state();
    draw();
    if (!playing || paused) { rafOn = false; return; }
    requestAnimationFrame(loop);
  });
}

export function guideTick() {
  const sec = player.positionSec();
  const live = sec === null || !invClock ? null : invClock(sec);
  if (guideFloor === null) return live;

  if (!player.isPaused() && live !== null && live >= guideFloor) guideFloor = null;
  return guideFloor ?? live;
}

let drawing = false;

export function draw() {
  if (drawing) return;
  drawing = true;
  try { paint(); } finally { drawing = false; }
}

function paint() {
  if (!cv) return;
  const W = box.clientWidth, H = box.clientHeight;
  if (W !== parseFloat(cv.style.width) || H !== parseFloat(cv.style.height)) resize();

  const gt = guideTick();
  if (gt !== null && sounding()) followGuide(gt, W);
  if (gt !== null) reportPlayItem(gt);

  g.clearRect(0, 0, W, H);
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);

  const t0 = Math.max(0, xToTick(GUTTER_W) - CELL_TICKS);
  const t1 = xToTick(W) + CELL_TICKS;
  const rowTop = Math.max(0, Math.floor((scrollY()) / ROW_H) - 1);
  const rowBot = Math.min(PITCH_ROWS - 1, Math.ceil((scrollY() + H) / ROW_H));

  drawRows(W, rowTop, rowBot);
  drawBadBars(W, H, t0, t1);
  drawGrid(W, H, t0, t1, rowTop, rowBot);
  drawNotes(t0, t1);
  if (drag && drag.mode !== "marquee") drawDrag();
  else if (!drag && hover) drawHover();
  if (drag && padCur) drawPadCursor();

  if (gt !== null) drawGuide(gt, H);

  drawMarkLines(H);

  drawKeyboard(H, rowTop, rowBot);
  drawRuler(W, t0, t1);
  drawMarks(H);

  if (drag?.mode === "marquee") drawMarquee();

  onView();
}

function stackedMeter(num, den, cx, cy, color) {
  g.font = 'bold 9px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(String(num), cx, cy - 3);
  g.fillText(String(den), cx, cy + 3);
}

function stackedWidth(num, den) {
  g.font = 'bold 9px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  return Math.max(g.measureText(String(num)).width, g.measureText(String(den)).width) + 4;
}

function drawMeterOnRuler(W, t0, t1) {
  if (!timeSigUI) return;
  g.save();
  g.beginPath();
  g.rect(GUTTER_W, 0, W - GUTTER_W, RULER_H);
  g.clip();

  const live = meterAt(Math.max(0, t0));
  let guardRight = GUTTER_W;
  if (live.tick > 0 && live.tick < t0) {
    const w = stackedWidth(live.num, live.den);
    g.fillStyle = C.rulerBg;
    g.fillRect(GUTTER_W, 1, w + 4, RULER_H - 2);
    stackedMeter(live.num, live.den, GUTTER_W + 2 + w / 2, RULER_H / 2, C.dimmer);
    guardRight = GUTTER_W + w + 6;
  }

  let lastRight = -Infinity;
  for (const m of meters()) {
    if (m.tick <= 0 || m.tick < t0 || m.tick > t1) continue;
    const w = stackedWidth(m.num, m.den);
    const x = Math.round(tickToX(m.tick));
    const left = x - w - 1;
    if (left < lastRight + 2 || left < guardRight) continue;
    lastRight = x;

    g.fillStyle = C.rulerBg;
    g.fillRect(left, 1, w, RULER_H - 2);
    stackedMeter(m.num, m.den, left + w / 2, RULER_H / 2, C.dim);
  }
  g.restore();
}

function drawRows(W, rowTop, rowBot) {
  for (let r = rowTop; r <= rowBot; r++) {
    const midi = ROLL_MAX - r;
    const pc = midi % 12;
    g.fillStyle = keyPcs === null
      ? (BLACK_KEYS.has(pc) ? C.rowBlack : C.rowWhite)
      : (keyPcs.has(pc) ? C.rowKeyIn : C.rowKeyOff);
    g.fillRect(GUTTER_W, midiToY(midi), W - GUTTER_W, ROW_H);
    if (!soundsAsWritten(midi)) {
      g.fillStyle = C.dimRow;
      g.fillRect(GUTTER_W, midiToY(midi), W - GUTTER_W, ROW_H);
    }
  }
}

function drawBadBars(W, H, t0, t1) {
  if (!badBars.size) return;
  const yTop = Math.max(RULER_H, midiToY(PITCH_MAX));
  const yBot = Math.min(H, midiToY(PITCH_MIN) + ROW_H);
  if (yBot <= yTop) return;

  g.fillStyle = C.badBar;
  for (let b = Math.max(0, barIndexOf(t0)); b <= barIndexOf(t1) + 1; b++) {
    if (!badBars.has(b)) continue;
    const x0 = Math.max(GUTTER_W, Math.round(tickToX(barStartTick(b))));
    const x1 = Math.min(W, Math.round(tickToX(barStartTick(b + 1))));
    if (x1 > x0) g.fillRect(x0, yTop, x1 - x0, yBot - yTop);
  }
}

const wantHalfGrid = () => snapMove() === FINE_TICKS && CELL_W >= 24;
function drawGrid(W, H, t0, t1, rowTop, rowBot) {
  const c0 = Math.max(0, Math.floor(t0 / CELL_TICKS));
  const c1 = Math.ceil(t1 / CELL_TICKS);
  const yTop = Math.max(RULER_H, midiToY(PITCH_MAX));
  const yBot = Math.min(H, midiToY(PITCH_MIN) + ROW_H);

  const step = gridStep(CELL_W);
  const cell = new Path2D(), beat = new Path2D(), bar = new Path2D();
  for (let c = c0; c <= c1; c++) {
    const tick = c * CELL_TICKS;
    const bs = barStartTick(barIndexOf(tick));
    const isBar = tick === bs;
    if (!isBar && c % step !== 0) continue;
    const x = Math.round(tickToX(tick)) + 0.5;
    if (x < GUTTER_W || x > W) continue;
    const beatTicks = PPQ * 4 / meterAt(tick).den;
    const p = isBar ? bar : (tick - bs) % beatTicks === 0 ? beat : cell;
    p.moveTo(x, yTop); p.lineTo(x, yBot);
  }
  const half = new Path2D();
  if (wantHalfGrid()) {
    for (let c = c0; c <= c1; c++) {
      const x = Math.round(tickToX(c * CELL_TICKS + FINE_TICKS)) + 0.5;
      if (x < GUTTER_W || x > W) continue;
      half.moveTo(x, yTop); half.lineTo(x, yBot);
    }
  }

  g.lineWidth = 1;
  g.strokeStyle = C.gridHalf; g.stroke(half);
  g.strokeStyle = C.gridCell; g.stroke(cell);
  g.strokeStyle = C.gridBeat; g.stroke(beat);
  g.strokeStyle = C.gridBar;  g.stroke(bar);

  const rowLines = rowLinesAt(ROW_H);
  const row = new Path2D(), oct = new Path2D(), edge = new Path2D();
  for (let r = rowTop; r <= rowBot + 1; r++) {
    const midi = ROLL_MAX - r;
    const y = Math.round(midiToY(midi) + ROW_H) + 0.5;
    if (y < RULER_H || y > H) continue;
    const isEdge = midi === GAME_MIN || midi === GAME_MAX + 1;
    const isOct = midi % 12 === 0;
    if (!isOct && !isEdge && !rowLines) continue;
    const p = isEdge ? edge : isOct ? oct : row;
    p.moveTo(GUTTER_W, y);
    p.lineTo(W, y);
  }
  g.strokeStyle = C.gridCell; g.stroke(row);
  g.strokeStyle = C.gridOct;  g.stroke(oct);
  g.strokeStyle = C.gridEdge; g.stroke(edge);
}

function drawNotes(t0, t1) {
  const n = Math.min(trackCount(), song ? song.tracks.length : 0);
  const shown = getGhosts();
  const on = ch => shown[ch] !== false;
  for (let ch = GAME_TRACKS; ch < n; ch++) if (ch !== active && on(ch)) paintTrack(ch, t0, t1, false);
  for (let ch = 0; ch < Math.min(n, GAME_TRACKS); ch++) if (ch !== active && on(ch)) paintTrack(ch, t0, t1, false);
  if (active < n && on(active)) paintTrack(active, t0, t1, true);
  if (selection.length && active < n && on(active) && !drag) markSelection(t0, t1);
}

function markSelection(t0, t1) {
  const notes = song.tracks[active].notes;
  g.strokeStyle = C.selEdge;
  g.lineWidth = 2;
  for (const nt of notes) {
    if (nt.tick > t1) break;
    if (nt.tick + nt.durTick < t0) continue;
    if (!selKeys.has(selKey(nt.tick, nt.midi))) continue;
    const { x0, x1, y } = noteRect(nt.tick, nt.durTick, nt.midi);
    g.strokeRect(x0 - 1, y, x1 - x0 + 2, ROW_H);
  }
  g.lineWidth = 1;
}

function paintTrack(ch, t0, t1, isActive) {
  const notes = song.tracks[ch].notes;
  const col = TRACK_COLORS[ch];
  g.lineWidth = 1;
  if (isActive) {
    g.fillStyle = rgba(col, ACTIVE_ALPHA);
    g.strokeStyle = noteEdgeShade > 0 ? dim(col, noteEdgeShade) : C.activeEdge;
  } else {
    g.fillStyle = rgba(col, ghostFillAlpha);
    g.strokeStyle = rgba(col, ch < GAME_TRACKS ? ghostAlpha : auxAlpha);
  }

  for (const nt of notes) {
    if (nt.tick > t1) break;
    if (nt.tick + nt.durTick < t0) continue;
    if (isActive && drag && drag.mode !== "marquee" && (drag.mode === "group"
      ? selKeys.has(selKey(nt.tick, nt.midi))
      : nt.tick === drag.from.tick && nt.midi === drag.from.midi)) continue;
    const { x0, x1, y } = noteRect(nt.tick, nt.durTick, nt.midi);
    const w = x1 - x0;
    const bad = isActive && badKeys.has(selKey(nt.tick, nt.midi));
    if (bad) g.fillStyle = rgba(C.bad, ACTIVE_ALPHA);
    g.fillRect(x0 + 1, y + 2, Math.max(1, w - 2), ROW_H - 4);
    if (bad) g.fillStyle = rgba(col, isActive ? ACTIVE_ALPHA : ghostFillAlpha);
    g.strokeRect(x0 + 0.5, y + 1.5, Math.max(1, w - 1), ROW_H - 3);
  }
}

function noteRect(tick, dur, midi) {
  const x0 = Math.round(tickToX(tick));
  const x1 = Math.max(x0 + 2, Math.round(tickToX(tick + dur)));
  return { x0, x1, y: Math.round(midiToY(midi)) };
}

const offscreen = r => r.x1 < GUTTER_W || r.x0 > box.clientWidth;

function dashedBox(tick, dur, midi) {
  const r = noteRect(tick, dur, midi);
  if (offscreen(r)) return;
  g.save();
  g.setLineDash([3, 3]);
  g.strokeStyle = C.hover;
  g.lineWidth = 1;
  g.strokeRect(r.x0 + 0.5, r.y + 1.5, Math.max(1, r.x1 - r.x0 - 1), ROW_H - 3);
  g.restore();
}

const drawHover = () => dashedBox(hover.tick, drawLen(), hover.midi);

function drawEffect() {
  if (!drag.effect) return;
  const { kill, trim } = drag.effect;
  g.save();
  g.lineWidth = 2;
  for (const nt of song?.tracks[active]?.notes ?? []) {
    const k = selKey(nt.tick, nt.midi);
    const color = kill.has(k) ? C.willKill : trim.has(k) ? C.willTrim : null;
    if (!color) continue;
    const r = noteRect(nt.tick, nt.durTick, nt.midi);
    if (offscreen(r)) continue;
    g.strokeStyle = color;
    g.strokeRect(r.x0 + 1, r.y + 2, Math.max(1, r.x1 - r.x0 - 2), ROW_H - 4);
  }
  g.restore();
}

function drawEdgeGuide(H) {
  const tick = edgeGuideAt();
  if (tick !== null) vline(tick, H, C.markHover, true);
}

function edgeGuideAt() {
  if (drag.mode === "group") {
    if (!drag.dTick) return null;
    const notes = song?.tracks[active]?.notes ?? [];
    const byKey = new Map();
    for (const nt of notes) byKey.set(selKey(nt.tick, nt.midi), nt);
    let tick = null;
    for (const p of drag.picks) {
      const nt = byKey.get(selKey(p.tick, p.midi));
      if (!nt) continue;
      const t = drag.dTick > 0 ? nt.tick + drag.dTick + nt.durTick : nt.tick + drag.dTick;
      tick = tick === null ? t : (drag.dTick > 0 ? Math.max(tick, t) : Math.min(tick, t));
    }
    return tick;
  }
  if (drag.mode === "resize") {
    return drag.to.dur === drag.from.dur ? null : drag.to.tick + drag.to.dur;
  }
  if (drag.mode !== "move") return null;
  const d = drag.to.tick - drag.from.tick;
  if (!d) return null;
  return d > 0 ? drag.to.tick + drag.to.dur : drag.to.tick;
}

function drawDrag() {
  if (drag.mode === "group") { drawGroupDrag(); drawEffect(); return; }
  const r = noteRect(drag.to.tick, drag.to.dur, drag.to.midi);
  if (!offscreen(r)) {
    g.fillStyle = rgba(TRACK_COLORS[active], 0.5);
    g.fillRect(r.x0 + 1, r.y + 2, Math.max(1, r.x1 - r.x0 - 2), ROW_H - 4);
    g.strokeStyle = C.activeEdge;
    g.lineWidth = 1;
    g.strokeRect(r.x0 + 0.5, r.y + 1.5, Math.max(1, r.x1 - r.x0 - 1), ROW_H - 3);
  }
  if (drag.mode !== "create") dashedBox(drag.from.tick, drag.from.dur, drag.from.midi);
  drawEffect();
}

function drawGroupDrag() {
  const notes = song?.tracks[active]?.notes ?? [];
  const byKey = new Map();
  for (const nt of notes) byKey.set(selKey(nt.tick, nt.midi), nt);

  g.lineWidth = 1;
  for (const p of drag.picks) {
    const nt = byKey.get(selKey(p.tick, p.midi));
    if (!nt) continue;
    const r = noteRect(nt.tick + drag.dTick, nt.durTick, nt.midi + drag.dMidi);
    if (!offscreen(r)) {
      g.fillStyle = rgba(TRACK_COLORS[active], 0.5);
      g.fillRect(r.x0 + 1, r.y + 2, Math.max(1, r.x1 - r.x0 - 2), ROW_H - 4);
      g.strokeStyle = C.activeEdge;
      g.strokeRect(r.x0 + 0.5, r.y + 1.5, Math.max(1, r.x1 - r.x0 - 1), ROW_H - 3);
    }
    dashedBox(nt.tick, nt.durTick, nt.midi);
  }
}

let lastPlayKey = null;

function reportPlayItem(tick) {
  const tr = player.state().song?.tracks[active];
  const it = tr ? itemAt(tr, tick) : null;
  const key = it ? `${it.srcStart}:${it.srcEnd}` : null;
  if (key === lastPlayKey) return;
  lastPlayKey = key;
  onPlayItem(it);
}

function itemAt(tr, tick) {
  for (const n of tr.notes) {
    if (n.tick > tick) break;
    if (tick < n.tick + n.durTick) return n;
  }
  for (const r of tr.rests ?? []) {
    if (r.tick > tick) break;
    if (tick < r.tick + r.dur) return r;
  }
  return null;
}

function drawGuide(tick, H) {
  const x = Math.round(tickToX(tick)) + 0.5;
  if (x < GUTTER_W || x > box.clientWidth) return;
  g.strokeStyle = C.guide;
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, H); g.stroke();
}

function vline(tick, H, color, dash, plain = false) {
  const x = Math.round(tickToX(tick)) + 0.5;
  if (x < GUTTER_W || x > box.clientWidth) return;
  g.save();
  if (dash) g.setLineDash([4, 4]);
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  if (!dash && !plain) {
    g.setLineDash([]);
    g.fillStyle = color;
    g.fillRect(x - 3.5, 1, 7, 5);
  }
  g.restore();
}

function drawMarks(H) {
  if (caret !== null) vline(caret, H, C.caret, false, true);
  if (markStart !== null) vline(markStart, H, C.markStart, false);
  if (markEnd !== null) vline(markEnd, H, C.markEnd, false);
  if (markCursor !== null) vline(markCursor, H, C.markHover, true);
  if (drag) drawEdgeGuide(H);
}

export const playRange = () => ({ fromTick: markStart, toTick: markEnd });

export const viewX = tick => tickToPx(tick, CELL_W);
export const viewScrollX = () => (box ? box.scrollLeft : 0);
export const viewWidth = () => contentW();

export function jumpTo(tick) {
  if (!box) return;
  const max = Math.max(0, GUTTER_W + contentW() - box.clientWidth);
  const left = Math.min(max, Math.max(0, viewX(tick) - Math.max(12, CELL_W)));
  const still = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (box.scrollTo) box.scrollTo({ left, behavior: still ? "auto" : "smooth" });
  else box.scrollLeft = left;
  draw();
}

export function setMarkLines(list) {
  const next = (list ?? []).map(m => ({ tick: m.tick, color: m.color }));
  const same = next.length === markLines.length
    && next.every((m, i) => m.tick === markLines[i].tick && m.color === markLines[i].color);
  if (same) return;
  markLines = next;
  draw();
}

export const setPlayStart = tick => setMarkStart(tick);
export const clearPlayRange = () => clearMarks();
export const setPlayEnd = tick => setMarkEnd(tick);

export function remapMarks(at, delta) {
  const gone = [at, at - delta];
  const map = m => {
    if (m === null) return null;
    if (delta > 0) return m >= at ? m + delta : m;
    if (m >= gone[1]) return m + delta;
    return m > gone[0] ? gone[0] : m;
  };
  markStart = map(markStart);
  markEnd = map(markEnd);
  if (markStart !== null && markEnd !== null && markEnd <= markStart) {
    clearMarks();
    return;
  }
  syncRange("shift");
  draw();
}

function keyAt(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (x < 0 || x >= GUTTER_W || y < RULER_H) return null;
  const midi = yToMidi(y);
  return playable(midi) ? midi : null;
}

function startAudition(midi, pid) {
  if (audition?.midi === midi) return;
  if (audition) onAuditionEnd();
  audition = { midi, pid };
  try { cv.setPointerCapture(pid); } catch {  }
  onAudition(midi);
  draw();
}

function endAudition() {
  if (!audition) return;
  try { cv.releasePointerCapture(audition.pid); } catch {  }
  audition = null;
  onAuditionEnd();
  draw();
}

const songEndTick = () => (song ? Math.max(0, ...song.tracks.map(t => t.endTick)) : 0);

function markTickRaw(e) {
  const r = cv.getBoundingClientRect();
  return Math.max(0, Math.round(xToTick(e.clientX - r.left) / CELL_TICKS) * CELL_TICKS);
}

function markTickAt(e) {
  const raw = markTickRaw(e);
  const end = songEndTick();
  return end > 0 ? Math.min(end, raw) : raw;
}

function rulerTick(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (y < 0 || y >= RULER_H || x < GUTTER_W || x > box.clientWidth) return null;
  return markTickAt(e);
}

function setMarkStart(tick) {
    if (markEnd !== null && tick >= markEnd) { say(i18n.t("roll.markStartAfterEnd")); return; }
  markStart = tick;
  syncRange("start");
  draw();
}

function setMarkEnd(tick) {
    if (markStart !== null && tick <= markStart) { say(i18n.t("roll.markEndBeforeStart")); return; }
  markEnd = tick;
  syncRange("end");
  draw();
}

function clearMarks() {
  markStart = markEnd = null;
  syncRange("clear");
  draw();
}

function syncRange(cause = null) {
  const part = markStart !== null || markEnd !== null;
  document.querySelectorAll("#rangeSel button[data-range]").forEach(b => {
    const on = (b.dataset.range === "part") === part;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  onRange(cause);
}

function drawMarkLines(H) {
  if (!markLines.length) return;
  g.save();
  g.globalAlpha = 0.5;
  g.lineWidth = 1;
  for (const m of markLines) {
    const x = Math.round(tickToX(m.tick)) + 0.5;
    if (x < GUTTER_W || x > box.clientWidth) continue;
    g.strokeStyle = m.color;
    g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, H); g.stroke();
  }
  g.restore();
}

function drawKeyboard(H, rowTop, rowBot) {
  g.fillStyle = C.gutterBg;
  g.fillRect(0, 0, GUTTER_W, H);

  g.font = '10px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  g.textAlign = "right";
  g.textBaseline = "middle";

  for (let r = rowTop; r <= rowBot; r++) {
    const midi = ROLL_MAX - r;
    const y = midiToY(midi);
    if (y + ROW_H < RULER_H || y > H) continue;
    const black = BLACK_KEYS.has(midi % 12);
    const down = audition?.midi === midi;
    const kw = black && !down ? GUTTER_W - 14 : GUTTER_W - 1;
    g.fillStyle = down ? TRACK_COLORS[active] : black ? C.keyBlack : C.keyWhite;
    g.fillRect(0, y, kw, ROW_H - 1);
    if (!soundsAsWritten(midi)) {
      g.fillStyle = C.dimKey;
      g.fillRect(0, y, kw, ROW_H - 1);
    }
    if (midi % 12 === 0) {
      g.fillStyle = C.keyLabel;
      g.fillText(`o${(midi - OCT_BASE) / 12}C`, GUTTER_W - 4, y + ROW_H / 2);
    }
  }

  g.fillStyle = C.line;
  g.fillRect(GUTTER_W - 1, 0, 1, H);
  g.fillStyle = C.rulerBg;
  g.fillRect(0, 0, GUTTER_W, RULER_H);
  g.fillStyle = C.line;
  g.fillRect(0, RULER_H - 1, GUTTER_W, 1);
  drawHeadMeter();
}

function drawHeadMeter() {
  if (!timeSigUI) return;
  const m = meterAt(0);
  g.save();
  stackedMeter(m.num, m.den, GUTTER_W / 2, RULER_H / 2, C.dim);
  g.restore();
}

function onHeadMeter(e) {
  if (!timeSigUI) return false;
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  return x >= 0 && x < GUTTER_W && y >= 0 && y < RULER_H;
}

function drawRuler(W, t0, t1) {
  g.fillStyle = C.rulerBg;
  g.fillRect(GUTTER_W, 0, W - GUTTER_W, RULER_H);
  g.fillStyle = C.line;
  g.fillRect(GUTTER_W, RULER_H - 1, W - GUTTER_W, 1);

  g.font = '10px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  g.textAlign = "left";
  g.textBaseline = "middle";
  const b0 = Math.max(0, barIndexOf(t0));
  const b1 = barIndexOf(t1) + 1;
  for (let b = b0; b <= b1; b++) {
    const x = tickToX(barStartTick(b));
    if (x < GUTTER_W - 1 || x > W) continue;
    g.fillStyle = C.line;
    g.fillRect(Math.round(x), 0, 1, RULER_H);
    g.fillStyle = C.dim;
    g.fillText(String(b + 1), Math.round(x) + 4, RULER_H / 2);
  }

  drawMeterOnRuler(W, t0, t1);
  drawRulerMarks(W, t1);
}

function drawRulerMarks(W, t1) {
  const tEvs = tempoChanges(song?.tempos);
  const vEvs = velChanges(song?.tracks?.[active]?.vels);
  if (!tEvs.length && !vEvs.length) return;

  const byTick = new Map();
  const at = tick => {
    let m = byTick.get(tick);
    if (!m) byTick.set(tick, m = { tick });
    return m;
  };
  for (const e of tEvs) if (e.tick <= t1) at(e.tick).bpm = e.bpm;
  for (const e of vEvs) if (e.tick <= t1) at(e.tick).v = e.v;

  g.save();
  g.beginPath();
  g.rect(GUTTER_W, 0, W - GUTTER_W, RULER_H);
  g.clip();
  g.font = 'bold 10px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  g.textAlign = "left";
  g.textBaseline = "middle";

  for (const m of [...byTick.values()].sort((a, b) => a.tick - b.tick)) {
    const x = Math.round(tickToX(m.tick)) + 0.5;
    const tLab = m.bpm !== undefined ? `T${m.bpm}` : "";
    const vLab = m.v !== undefined ? `V${m.v}` : "";
    const tw = g.measureText(tLab).width;
    const vw = g.measureText(vLab).width;
    const gap = tLab && vLab ? g.measureText(" ").width : 0;
    const total = tw + gap + vw;
    if (x > W || x < GUTTER_W - total - 12) continue;

    g.fillStyle = C.rulerBg;
    g.fillRect(x - 5, 1, total + 12, RULER_H - 2);

    g.fillStyle = tLab ? C.tempo : C.vel;
    g.beginPath();
    g.moveTo(x - 4, 4);
    g.lineTo(x + 4, 4);
    g.lineTo(x, 11);
    g.closePath();
    g.fill();

    if (tLab) {
      g.fillStyle = C.tempo;
      g.fillText(tLab, x + 6, RULER_H / 2);
    }
    if (vLab) {
      g.fillStyle = C.vel;
      g.fillText(vLab, x + 6 + tw + gap, RULER_H / 2);
    }
  }
  g.restore();
}

function followGuide(tick, W) {
  if (!follow) return;
  const pageW = Math.max(1, W - GUTTER_W);
  const cx = (tick / CELL_TICKS) * CELL_W;
  const want = Math.floor(cx / pageW) * pageW;
  const max = Math.max(0, GUTTER_W + contentW() - W);
  const target = Math.min(want, max);
  if (Math.abs(box.scrollLeft - target) < 1) return;
  expectScrollLeft = target;
  box.scrollLeft = target;
}

function onPointerDown(e) {
  lastDownTouch = e.pointerType === "touch";

  if (e.button !== 0) return;

  if (e.pointerType === "touch") {
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPts.size >= 2) { secondTouch(); return; }
  }

  const rt = rulerTick(e);
  if (rt !== null) {
    if (e.pointerType !== "touch") { e.preventDefault(); setMarkStart(rt); return; }

    gesture = {
      kind: "pending", pid: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      at: null, menuOnly: true, rulerTick: rt,
      timer: setTimeout(holdFire, LONG_MS),
    };
    return;
  }

  const key = keyAt(e);
  if (key !== null) {
    if (e.pointerType !== "touch") e.preventDefault();
    startAudition(key, e.pointerId);
    return;
  }

  if (!song) return;

  if (e.pointerType === "touch") { touchDown(e); return; }

  const at = locate(e);
  if (!at) return;

  const grab = () => e.preventDefault();

  if (at.hit) {
    grab();

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !sounding()) {
      if (!selKeys.has(selKey(at.hit.tick, at.hit.midi))) {
        onAuditionNote(at.hit.midi, at.hit.dur, at.hit.vel);
      }
      onTogglePick({ tick: at.hit.tick, midi: at.hit.midi });
      anchor = { tick: at.hit.tick, midi: at.hit.midi };
      hover = null;
      draw();
      return;
    }

    if (!sounding()) onAuditionNote(at.hit.midi, at.hit.dur, at.hit.vel);

    if (e.shiftKey) {
      const live = anchor && (song.tracks[active]?.notes ?? [])
        .some(n => n.tick === anchor.tick && n.midi === anchor.midi);
      if (live && !sounding()) {
        onRangePick({ from: { ...anchor }, to: { tick: at.hit.tick, midi: at.hit.midi } });
        hover = null;
        draw();
        return;
      }
    }

    const inSel = selection.length > 1 && selKeys.has(selKey(at.hit.tick, at.hit.midi));
    if (!inSel) onPick(at.hit);
    if (!inSel) anchor = { tick: at.hit.tick, midi: at.hit.midi };

    if (canEdit()) {
      hover = null;
      if (inSel) {
        drag = {
          mode: "group",
          picks: selection.map(n => ({ ...n })),
          dTick: 0, dMidi: 0,
          grabTick: at.rawTick,
          grabMidi: at.midi,
          ...fineInit(at),
          moved: false,
          pid: e.pointerId,
        };
      } else {
        const from = { tick: at.hit.tick, midi: at.hit.midi, dur: at.hit.durTick };
        drag = {
          mode: at.onEdge ? "resize" : "move",
          from,
          to: { ...from },
          grabTick: at.rawTick,
          grabMidi: at.midi,
          ...fineInit(at),
          moved: false,
          pid: e.pointerId,
        };
      }
      syncToolbar();
      try { cv.setPointerCapture(e.pointerId); } catch {  }
    }
    draw();
    return;
  }

  if (at.ghost) {
    grab();
    onPickGhost({ ch: at.ghost.ch, note: at.ghost.note });
    anchor = { tick: at.ghost.note.tick, midi: at.ghost.note.midi };
    ghostSwitchAt = performance.now();
    hover = null;
    markCursor = null;
    draw();
    return;
  }

  if (!canDraw()) {
    if (tool === "select" && !sounding()) {
      grab();
      pend = {
        pid: e.pointerId,
        x0: e.clientX, y0: e.clientY,
        markTick: markTickAt(e),
        grabTick: at.rawTick, grabMidi: at.midi,
        add: e.ctrlKey || e.metaKey,
      };
      try { cv.setPointerCapture(e.pointerId); } catch {  }
      return;
    }

    if (!sounding()) onPick(null);
    if (tool === "select") {
      grab();
      setMarkStart(markTickAt(e));
    }
    draw();
    return;
  }
  grab();
  startCreate(e.pointerId, at);
}

function startCreate(pid, at) {
  const from = { tick: at.tick, midi: at.midi, dur: drawLen() };
  drag = {
    mode: "create",
    from, to: { ...from },
    grabTick: at.rawTick,
    grabMidi: at.midi,
    ...fineInit(at),
    moved: false,
    pid,
    cancel: false,
    clock: makeClock(song.tempos ?? []),
  };
  drag.audVel = velAt(at.tick);
  auditionDrag(at.midi);
  hover = null;
  refreshEffect();
  syncToolbar();
  try { cv.setPointerCapture(pid); } catch {  }
  draw();
}

function velAt(tick) {
  let v = 100;
  for (const n of song?.tracks[active]?.notes ?? []) {
    if (n.tick > tick) break;
    v = n.vel;
  }
  return v;
}

function touchDown(e) {
  if (drag || gesture) return;

  const at = locate(e);
  if (!at) return;

  gesture = {
    kind: "pending", pid: e.pointerId,
    x0: e.clientX, y0: e.clientY,
    at,
    timer: setTimeout(holdFire, LONG_MS),
  };
}

function secondTouch() {
  if (audition) return;
  if (drag) return;
  if (gesture?.kind === "pending") clearTimeout(gesture.timer);

  if (gesture?.kind === "zoom") { gesture.ref = spanOf(gesture.axis) ?? gesture.ref; return; }
  if (gesture?.kind === "pan") { const c = centroid(); gesture.cx = c.x; gesture.cy = c.y; return; }

  const c = centroid(), s = span();
  gesture = s
    ? { kind: "two", cx0: c.x, cy0: c.y, sx0: s.x, sy0: s.y }
    : { kind: "pan", cx: c.x, cy: c.y };
}

function centroid() {
  let x = 0, y = 0;
  for (const p of touchPts.values()) { x += p.x; y += p.y; }
  const n = Math.max(1, touchPts.size);
  return { x: x / n, y: y / n };
}

function span() {
  if (touchPts.size < 2) return null;
  const it = touchPts.values();
  const a = it.next().value, b = it.next().value;
  return { x: Math.abs(a.x - b.x), y: Math.abs(a.y - b.y) };
}

function spanOf(axis) {
  const s = span();
  if (!s) return null;
  const v = axis === "w" ? s.x : s.y;
  return v >= PINCH_SPAN ? v : null;
}

function startPan() {
  const c = centroid();
  gesture = { kind: "pan", cx: c.x, cy: c.y };
}

function twoMove() {
  const g = gesture, s = span();
  if (!s) return;
  const c = centroid();
  const dPan = Math.hypot(c.x - g.cx0, c.y - g.cy0);

  const axis = pinchAxis(s, { x: g.sx0, y: g.sy0 }, dPan);
  if (axis) {
    gesture = { kind: "zoom", axis, ref: axis === "w" ? s.x : s.y };
    return;
  }
  if (dPan >= TAP_SLOP) startPan();
}

function zoomMove() {
  const g = gesture;
  const cur = spanOf(g.axis);
  if (cur === null) return;
  const dir = zoomTick(cur, g.ref);
  if (!dir) return;
  g.ref = cur;
  const c = centroid(), rect = cv.getBoundingClientRect();
  stepZoom(g.axis, dir, { x: c.x - rect.left, y: c.y - rect.top });
}

function panMove() {
  const c = centroid();
  box.scrollLeft -= c.x - gesture.cx;
  box.scrollTop  -= c.y - gesture.cy;
  gesture.cx = c.x; gesture.cy = c.y;
}

function holdFire() {
  if (gesture?.kind !== "pending") return;
  const g0 = gesture;
  gesture = null;
  if (g0.menuOnly) { openMenu(g0.x0, g0.y0); return; }
  if (g0.at.hit && canEdit()) { holdDrag(g0); return; }
  if (!g0.at.hit && canDraw()) { startCreate(g0.pid, g0.at); return; }
  openMenu(g0.x0, g0.y0);
}

function holdDrag(g0) {
  const at = g0.at, hit = at.hit;
  const inSel = selection.length > 1 && selKeys.has(selKey(hit.tick, hit.midi));

  const base = {
    grabTick: at.rawTick, grabMidi: at.midi,
    ...fineInit(at),
    moved: false, pid: g0.pid,
  };
  if (inSel) {
    drag = { mode: "group", picks: selection.map(n => ({ ...n })), dTick: 0, dMidi: 0, ...base };
  } else {
    const from = { tick: hit.tick, midi: hit.midi, dur: hit.durTick };
    drag = { mode: "move", from, to: { ...from }, ...base };
    onPick(hit);
    anchor = { tick: hit.tick, midi: hit.midi };
  }

  onAuditionNote(hit.midi, hit.dur, hit.vel);
  hover = null;
  syncToolbar();
  try { cv.setPointerCapture(g0.pid); } catch {  }
  draw();
}

function tapPick(g0) {
  const at = g0.at;

  if (!at.hit && canDraw()) {
    startCreate(g0.pid, at);
    endDrag(true);
    return;
  }

  if (at.hit) {
    const key = selKey(at.hit.tick, at.hit.midi);
    const picked = selKeys.has(key);

    if (multiPick) {
      if (!picked && !sounding()) onAuditionNote(at.hit.midi, at.hit.dur, at.hit.vel);
      onTogglePick({ tick: at.hit.tick, midi: at.hit.midi });
      anchor = { tick: at.hit.tick, midi: at.hit.midi };
      draw();
      return;
    }

    if (!sounding()) onAuditionNote(at.hit.midi, at.hit.dur, at.hit.vel);
    onPick(at.hit);
    anchor = { tick: at.hit.tick, midi: at.hit.midi };
    draw();
    return;
  }

  if (rolljoy.isOpen()) return;

  if (!sounding()) onPick(null);
  if (tool === "select") setMarkStart(markTickAt({ clientX: g0.x0, clientY: g0.y0 }));
  draw();
}

function onTouchMove(e) {
  const p = touchPts.get(e.pointerId);
  if (p) { p.x = e.clientX; p.y = e.clientY; }

  if (audition && audition.pid === e.pointerId) {
    const k = keyAt(e);
    if (k !== null) startAudition(k, audition.pid);
    return;
  }
  if (gesture?.kind === "two") { twoMove(); return; }
  if (gesture?.kind === "zoom") { zoomMove(); return; }
  if (gesture?.kind === "pan") { panMove(); return; }
  if (drag) { if (e.pointerId === drag.pid) onDragMove(e); return; }
  if (gesture?.kind !== "pending" || gesture.pid !== e.pointerId) return;

  if (Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) <= TAP_SLOP) return;
  clearTimeout(gesture.timer);
  if (wantTouchMarquee(gesture)) { startTouchMarquee(e); return; }
  startPan();
}

const marqueeArmed = () => multiPick && tool === "select" && !sounding();

const wantTouchMarquee = g => marqueeArmed() && !!g.at && !g.at.hit;

function startTouchMarquee(e) {
  const g0 = gesture;
  gesture = null;
  pend = {
    pid: g0.pid, x0: g0.x0, y0: g0.y0,
    markTick: 0,
    grabTick: g0.at.rawTick, grabMidi: g0.at.midi,
    add: true,
  };
  try { cv.setPointerCapture(g0.pid); } catch {  }
  startMarquee(e);
}

function onTouchUp(e, ok) {
  touchPts.delete(e.pointerId);
  if (audition?.pid === e.pointerId) endAudition();

  if (gesture?.kind === "two" || gesture?.kind === "zoom") {
    if (touchPts.size < 2) gesture = null;
    return;
  }
  if (gesture?.kind === "pan") {
    if (touchPts.size === 0) gesture = null;
    else { const c = centroid(); gesture.cx = c.x; gesture.cy = c.y; }
    return;
  }
  if (gesture?.kind === "pending" && gesture.pid === e.pointerId) {
    clearTimeout(gesture.timer);
    const g0 = gesture;
    gesture = null;
    if (ok && g0.menuOnly) { setMarkStart(g0.rulerTick); return; }
    if (ok) tapPick(g0);
    return;
  }
  if (drag && drag.pid === e.pointerId) endDrag(ok);
}

function onPointerUp(e, ok) {
  if (e.pointerType === "touch") { onTouchUp(e, ok); return; }
  endAudition();

  if (pend) {
    const p = pend;
    pend = null;
    try { cv.releasePointerCapture(p.pid); } catch {  }
    if (ok) {
      if (!sounding()) onPick(null);
      setMarkStart(p.markTick);
    }
    draw();
    return;
  }
  endDrag(ok);
}

let edgeRaf = 0;
let edgePt = null;
let edgeVx = 0, edgeVy = 0;
let edgeLast = 0;

function edgeV(near, far) {
  if (near < EDGE_ZONE) return -EDGE_MAX * Math.min(1, (EDGE_ZONE - near) / EDGE_ZONE);
  if (far  < EDGE_ZONE) return  EDGE_MAX * Math.min(1, (EDGE_ZONE - far)  / EDGE_ZONE);
  return 0;
}

function edgeScroll(pt) {
  edgePt = pt;
  if (!pt) { edgeVx = edgeVy = 0; return; }
  const r = cv.getBoundingClientRect();
  const x = pt.x - r.left, y = pt.y - r.top;
  edgeVx = edgeV(x - GUTTER_W, box.clientWidth - x);
  edgeVy = edgeV(y - RULER_H, box.clientHeight - y);
  if ((edgeVx || edgeVy) && !edgeRaf) {
    edgeLast = 0;
    edgeRaf = requestAnimationFrame(edgeStep);
  }
}

function edgeStep(t) {
  edgeRaf = 0;
  if (!drag || !edgePt || (!edgeVx && !edgeVy)) return;
  const dt = edgeLast ? Math.min(0.05, (t - edgeLast) / 1000) : 0;
  edgeLast = t;
  const x0 = box.scrollLeft, y0 = box.scrollTop;
  box.scrollLeft = x0 + edgeVx * dt;
  box.scrollTop  = y0 + edgeVy * dt;
  if (box.scrollLeft !== x0 || box.scrollTop !== y0) {
    const r = cv.getBoundingClientRect();
    drag.lastTick = xToTick(edgePt.x - r.left);
    drag.lastMidi = yToMidi(edgePt.y - r.top);
    if (drag.mode === "marquee") marqueeMove();
    else updatePreview();
  }
  edgeRaf = requestAnimationFrame(edgeStep);
}

function stopEdgeScroll() {
  if (edgeRaf) cancelAnimationFrame(edgeRaf);
  edgeRaf = 0; edgePt = null; edgeVx = edgeVy = 0;
}

function marqueeBox() {
  return {
    t0: Math.min(drag.grabTick, drag.lastTick),
    t1: Math.max(drag.grabTick, drag.lastTick),
    m0: Math.min(drag.grabMidi, drag.lastMidi),
    m1: Math.max(drag.grabMidi, drag.lastMidi),
  };
}

function marqueeHits() {
  const { t0, t1, m0, m1 } = marqueeBox();
  const out = [];
  for (const n of song?.tracks[active]?.notes ?? []) {
    if (n.tick > t1) break;
    if (n.tick + n.durTick < t0) continue;
    if (n.midi < m0 || n.midi > m1) continue;
    out.push({ tick: n.tick, midi: n.midi });
  }
  return out;
}

function marqueeMove() {
  const hits = marqueeHits();
  const sig = hits.map(n => selKey(n.tick, n.midi)).join(",");
  if (sig !== drag.sig) {
    drag.sig = sig;
    onSetPicks(drag.add
      ? [...drag.base, ...hits.filter(n => !drag.baseKeys.has(selKey(n.tick, n.midi)))]
      : hits);
  }
  draw();
}

function startMarquee(e) {
  const p = pend;
  pend = null;
  hover = null;
  markCursor = null;
  drag = {
    mode: "marquee",
    pid: p.pid,
    add: p.add,
    grabTick: p.grabTick, grabMidi: p.grabMidi,
    lastTick: p.grabTick, lastMidi: p.grabMidi,
    base: selection.map(n => ({ tick: n.tick, midi: n.midi })),
    baseKeys: new Set(selection.map(n => selKey(n.tick, n.midi))),
    sig: null,
  };
  syncToolbar();
  onDragMove(e);
}

function drawMarquee() {
  const { t0, t1, m0, m1 } = marqueeBox();
  const x0 = Math.max(GUTTER_W, Math.round(tickToX(t0)));
  const x1 = Math.min(box.clientWidth, Math.round(tickToX(t1)));
  const y0 = Math.max(RULER_H, Math.round(midiToY(m1)));
  const y1 = Math.min(box.clientHeight, Math.round(midiToY(m0)) + ROW_H);
  if (x1 < x0 || y1 < y0) return;
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);

  g.save();
  g.fillStyle = C.marquee;
  g.fillRect(x0, y0, w, h);
  g.setLineDash([4, 4]);
  g.strokeStyle = C.marqueeEdge;
  g.lineWidth = 1;
  g.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
  g.restore();
}

function onDragMove(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;

  if (drag.mode === "create") {
    const off = x < GUTTER_W || y < RULER_H;
    if (off !== drag.cancel) { drag.cancel = off; refreshEffect(); draw(); }
    if (off) { edgeScroll(null); return; }
  }

  drag.lastTick = xToTick(x);
  drag.lastMidi = yToMidi(y);
  if (drag.mode === "marquee") marqueeMove();
  else updatePreview();
  edgeScroll(e.pointerType === "touch" || drag.mode === "marquee"
    ? { x: e.clientX, y: e.clientY } : null);
}

function nudge(key, shift) {
  if (!drag) return false;
  if (drag.mode === "marquee")
    return key === "ArrowLeft" || key === "ArrowRight"
        || key === "ArrowUp"   || key === "ArrowDown";
  const resize = drag.mode === "resize";
  const dt = shift ? barTicksAt(barRefTick()) : FINE_TICKS;
  const dead = false;
  switch (key) {
    case "ArrowLeft":  drag.fineTick -= dt; break;
    case "ArrowRight": drag.fineTick += dt; break;
    case "ArrowUp":    if (!resize && !dead) drag.fineRows += shift ? 12 : 1; break;
    case "ArrowDown":  if (!resize && !dead) drag.fineRows -= shift ? 12 : 1; break;
    default: return false;
  }
  updatePreview();
  return true;
}

function barRefTick() {
  if (drag.mode === "group")
    return Math.max(0, Math.min(...drag.picks.map(n => n.tick)) + drag.dTick);
  if (drag.mode === "resize") return drag.to.tick + drag.to.dur;
  return drag.to.tick;
}

function updatePreview() {
  const step = drag.pid === null ? FINE_TICKS : snapMove();
  const dCells = Math.round((drag.lastTick - drag.grabTick) / step);
  const dTickRaw = dCells * step + drag.fineTick;
  const dRowsAll = (drag.lastMidi - drag.grabMidi) + drag.fineRows;

  if (drag.mode === "group") { groupDragMove(dTickRaw, dRowsAll); return; }

  const to = { ...drag.from };
  if (drag.mode === "resize") {
    to.dur = Math.max(FINE_TICKS, drag.from.dur + dTickRaw);
  } else {
    to.tick = Math.max(0, drag.from.tick + dTickRaw);
    to.midi = Math.min(PITCH_MAX, Math.max(PITCH_MIN, drag.from.midi + dRowsAll));
  }

  if (to.tick === drag.to.tick && to.midi === drag.to.midi && to.dur === drag.to.dur) return;
  const pitchChanged = to.midi !== drag.to.midi;
  drag.to = to;
  drag.moved = to.tick !== drag.from.tick || to.midi !== drag.from.midi || to.dur !== drag.from.dur;
  if (pitchChanged) auditionDrag(to.midi);
  refreshEffect();
  draw();
}

const auditionDrag = midi => {
  if (drag.mode === "create") {
    const { tick, dur } = drag.to;
    onAuditionNote(midi, drag.clock(tick + dur) - drag.clock(tick), drag.audVel);
    return;
  }
  onAuditionNote(midi, drag.audSec, drag.audVel);
};

const fineInit = at => ({
  fineTick: 0, fineRows: 0,
  lastTick: at.rawTick, lastMidi: at.midi,
  effect: null, effectSig: "",
  audSec: at.hit?.dur ?? 0, audVel: at.hit?.vel ?? 100,
});

function refreshEffect() {
  drag.effect = previewEffect();
  const sig = drag.effect ? `${drag.effect.nKill}/${drag.effect.nTrim}` : "";
  if (sig === drag.effectSig) return;
  drag.effectSig = sig;
  syncToolbar();
}

function previewEffect() {
  if (drag.cancel) return null;

  const notes = (song?.tracks[active]?.notes ?? [])
    .map(n => ({ tick: n.tick, dur: n.durTick, midi: n.midi }));
  if (!notes.length) return null;

  if (drag.mode === "create")
    return summarize(overwriteEffect(notes, [{ tick: drag.to.tick, dur: drag.to.dur }], []));

  if (drag.mode === "group") {
    if (!drag.dTick && !drag.dMidi) return null;
    const byKey = new Map(notes.map(n => [selKey(n.tick, n.midi), n]));
    const places = [];
    for (const p of drag.picks) {
      const n = byKey.get(selKey(p.tick, p.midi));
      if (n) places.push({ tick: Math.max(0, n.tick + drag.dTick), dur: n.dur });
    }
    return summarize(overwriteEffect(notes, places, drag.picks));
  }
  if (!drag.moved) return null;
  return summarize(overwriteEffect(
    notes,
    [{ tick: drag.to.tick, dur: drag.to.dur }],
    [{ tick: drag.from.tick, midi: drag.from.midi }],
  ));
}

function summarize({ killed, trimmed }) {
  if (!killed.length && !trimmed.length) return null;
  return {
    kill: new Set(killed.map(n => selKey(n.tick, n.midi))),
    trim: new Set(trimmed.map(n => selKey(n.tick, n.midi))),
    nKill: killed.length,
    nTrim: trimmed.length,
  };
}

function groupDragMove(dTickRaw, dRows) {
  const ticks = drag.picks.map(n => n.tick);
  const midis = drag.picks.map(n => n.midi);
  const dTick = Math.max(-Math.min(...ticks), dTickRaw);
  const dMidi = Math.min(PITCH_MAX - Math.max(...midis),
                Math.max(PITCH_MIN - Math.min(...midis), dRows));

  if (dTick === drag.dTick && dMidi === drag.dMidi) return;
  const pitchChanged = dMidi !== drag.dMidi;
  drag.dTick = dTick;
  drag.dMidi = dMidi;
  drag.moved = dTick !== 0 || dMidi !== 0;
  if (pitchChanged) auditionDrag(drag.grabMidi + dMidi);
  refreshEffect();
  draw();
}

function endDrag(commit) {
  if (!drag) return;
  const d = drag;
  stopEdgeScroll();
  padDisarm();
  padCur = null;
  try { cv.releasePointerCapture(d.pid); } catch {  }
  drag = null;

  if (d.mode === "marquee") {
    if (!commit) onPick(null);
    syncToolbar();
    draw();
    return;
  }

  if (commit && d.mode === "create") { if (!d.cancel) commitCreate(d); }
  else if (commit && d.moved) {
    if (d.mode === "group") {
      onMove({ picks: d.picks, dTick: d.dTick, dMidi: d.dMidi });
    } else if (onMove({ from: d.from, to: d.to })) {
      const n = song.tracks[active]?.notes.find(x => x.tick === d.to.tick && x.midi === d.to.midi);
      if (n) onPick(n);
    }
  }
  syncToolbar();
  draw();
}

function commitCreate(d) {
  const { tick, midi, dur } = d.to;
  if (!onAdd({ tick, dur, midi })) { onPick(null); return; }
  const added = song.tracks[active]?.notes.find(n => n.tick === tick && n.midi === midi);
  onPick(added ?? null);
}

const KEEP_MARGIN = 8;

const wantJoy = () =>
  lastDownTouch && selection.length > 0 && canEdit()
  && !editing(document.activeElement);

let joySyncing = false;
function syncJoy() {
  if (joySyncing) return;
  joySyncing = true;
  try {
    if (wantJoy()) {
      document.body.classList.add("joy");
      const opening = !rolljoy.isOpen();
      rolljoy.show({ canResize: selection.length === 1, multi: multiPick });
      rolljoy.place();
      if (opening && !drag) keepSelVisible();
      return;
    }
    document.body.classList.remove("joy");
    if (!rolljoy.isOpen()) return;
    if (drag && drag.pid === null) endDrag(true);
    rolljoy.hide();
  } finally {
    joySyncing = false;
  }
}

function padPick() {
  if (!canEdit() || !selection.length) return null;
  const notes = song?.tracks[active]?.notes ?? [];
  return notes.find(n => n.tick === selection[0].tick && n.midi === selection[0].midi) ?? null;
}

const padBase = (pick, grabTick) => ({
  grabTick, grabMidi: pick.midi,
  lastTick: grabTick, lastMidi: pick.midi,
  fineTick: 0, fineRows: 0,
  effect: null, effectSig: "",
  audSec: pick.dur, audVel: pick.vel,
  moved: false, pid: null,
});

function padStart() {
  if (drag) return;
  const pick = padPick();
  if (!pick || selection.length !== 1) return;
  padCur = {
    x: tickToPx(pick.tick + pick.durTick, CELL_W),
    y: (midiToRow(pick.midi) + 0.5) * ROW_H,
  };
  const from = { tick: pick.tick, midi: pick.midi, dur: pick.durTick };
  drag = { mode: "resize", from, to: { ...from }, ...padBase(pick, pxToTick(padCur.x, CELL_W)) };
  syncToolbar();
  draw();
}

function padMove(kind, dx) {
  if (!drag || !padCur) return;
  padCur.x = clamp(padCur.x + dx, 0, contentW());
  drag.lastTick = pxToTick(padCur.x, CELL_W);
  updatePreview();
  keepSelVisible();
  draw();
}

function padEnd() {
  endDrag(true);
}

const PAD_COMMIT_MS = 400;

let padCommit = 0;

function padStep(dir) {
  if (!canEdit() || !selection.length) return;
  if (drag && drag.mode === "resize") endDrag(true);
  if (!drag) {
    const pick = padPick();
    if (!pick) return;
    const grabTick = pick.tick;
    if (selection.length > 1) {
      drag = { mode: "group", picks: selection.map(n => ({ ...n })), dTick: 0, dMidi: 0,
               ...padBase(pick, grabTick) };
    } else {
      const from = { tick: pick.tick, midi: pick.midi, dur: pick.durTick };
      drag = { mode: "move", from, to: { ...from }, ...padBase(pick, grabTick) };
    }
    syncToolbar();
  }

  if (dir === "left" || dir === "right") {
    drag.fineTick += dir === "right" ? FINE_TICKS : -FINE_TICKS;
  } else {
    drag.fineRows += dir === "up" ? 1 : -1;
  }
  updatePreview();
  keepSelVisible();
  draw();
  padDisarm();
}

function padStepEnd() {
  if (drag && drag.pid === null) padArm();
}

function padArm() {
  clearTimeout(padCommit);
  padCommit = setTimeout(() => {
    padCommit = 0;
    if (drag && drag.pid === null) endDrag(true);
  }, PAD_COMMIT_MS);
}

function padDisarm() {
  clearTimeout(padCommit);
  padCommit = 0;
}

function drawPadCursor() {
  const x = Math.round(GUTTER_W + padCur.x - scrollX());
  const y = Math.round(RULER_H + padCur.y - scrollY());
  if (x < GUTTER_W || y < RULER_H) return;
  g.save();
  g.strokeStyle = C.activeEdge;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x - 7, y + 0.5); g.lineTo(x + 7, y + 0.5);
  g.moveTo(x + 0.5, y - 7); g.lineTo(x + 0.5, y + 7);
  g.stroke();
  g.restore();
}

function openSelMenu(x, y) {
  if (!song || !selection.length) return;
  const s = selection[0];
  const hit = (song.tracks[active]?.notes ?? []).find(n => n.tick === s.tick && n.midi === s.midi);
  if (!hit) return;
  onNoteMenu({
    x, y,
    note: { tick: hit.tick, midi: hit.midi, dur: hit.durTick },
    canEdit: canEdit(),
    whyNot: canEdit() ? "" : whyNot,
  });
}

function keepSelVisible() {
  if (!rolljoy.isOpen() || !song) return;
  const b = editBox();
  if (!b) return;

  const bottom = box.clientHeight - Math.max(0, box.getBoundingClientRect().bottom - rolljoy.top());
  const dx = overflow(tickToX(b.t0), tickToX(b.t1), GUTTER_W, box.clientWidth);
  const dy = overflow(midiToY(b.hi), midiToY(b.lo) + ROW_H, RULER_H, bottom);
  if (!dx && !dy) return;

  box.scrollLeft += dx;
  box.scrollTop += dy;
  expectScrollLeft = box.scrollLeft;
}

function overflow(a, b, lo, hi) {
  const m = KEEP_MARGIN;
  if (b - a > hi - lo - m * 2) return Math.round(a - lo - m);
  if (a < lo + m) return Math.round(a - lo - m);
  if (b > hi - m) return Math.round(b - hi + m);
  return 0;
}

function editBox() {
  const notes = song?.tracks[active]?.notes ?? [];
  const durOf = (tick, midi) =>
    notes.find(n => n.tick === tick && n.midi === midi)?.durTick ?? CELL_TICKS;

  if (drag?.mode === "move" || drag?.mode === "create" || drag?.mode === "resize") {
    const { tick, midi, dur } = drag.to;
    return { t0: tick, t1: tick + dur, lo: midi, hi: midi };
  }
  const picks = drag?.mode === "group"
    ? drag.picks.map(p => ({ tick: p.tick + drag.dTick, midi: p.midi + drag.dMidi,
                             dur: durOf(p.tick, p.midi) }))
    : selection.map(p => ({ tick: p.tick, midi: p.midi, dur: durOf(p.tick, p.midi) }));
  if (!picks.length) return null;

  return {
    t0: Math.min(...picks.map(p => p.tick)),
    t1: Math.max(...picks.map(p => p.tick + p.dur)),
    lo: Math.min(...picks.map(p => p.midi)),
    hi: Math.max(...picks.map(p => p.midi)),
  };
}

const sounding = () => player.isPlaying() && !player.isPaused();

const canEdit = () => editable && !sounding();

const canDraw = () => canEdit() && tool === "draw";

export const editing = t =>
  t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement
  || t instanceof HTMLSelectElement
  || (t instanceof HTMLElement && t.isContentEditable);

export const isDragging = () => !!drag;

function onDoubleClick(e) {
  if (lastDownTouch || tool !== "select" || sounding() || !song) return;
  if (performance.now() - ghostSwitchAt < GHOST_DBL_MS) return;
  const hit = locate(e)?.hit;
  if (!hit) return;
  e.preventDefault();
  onJumpText(hit);
}

const TOUCH_PICK_R = 10;

function touchNear(rawTick, midi, y) {
  const rows = Math.floor((TOUCH_PICK_R + ROW_H / 2) / ROW_H);
  if (rows < 1) return undefined;
  const notes = song?.tracks[active]?.notes ?? [];
  let best, bestD = TOUCH_PICK_R;
  for (let k = 1; k <= rows; k++) {
    for (const d of [k, -k]) {
      const m = midi + d;
      if (!playable(m)) continue;
      const dist = Math.abs(midiToY(m) + ROW_H / 2 - y);
      if (dist >= bestD) continue;
      for (const n of notes) {
        if (n.tick > rawTick) break;
        if (n.midi === m && rawTick < n.tick + n.durTick) { best = n; bestD = dist; break; }
      }
    }
  }
  return best;
}

function locate(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (x < GUTTER_W || y < RULER_H) return null;
  const rawTick = xToTick(x), midi = yToMidi(y);
  if (!playable(midi) || rawTick < 0) return null;
  let hit;
  for (const n of song?.tracks[active]?.notes ?? []) {
    if (n.tick > rawTick) break;
    if (n.midi === midi && rawTick < n.tick + n.durTick) { hit = n; break; }
  }
  if (!hit && e?.pointerType === "touch") hit = touchNear(rawTick, midi, y);
  const ghost = !hit && tool === "select" && song
    ? ghostAt(song.tracks, {
        active, count: trackCount(), shown: getGhosts(), rawTick, midi,
      })
    : null;

  let onEdge = false;
  if (hit) {
    const x0 = tickToX(hit.tick), x1 = tickToX(hit.tick + hit.durTick);
    const zone = Math.min(RESIZE_ZONE, Math.max(2, (x1 - x0) / 3));
    onEdge = x >= x1 - zone;
  }
  return { x, y, rawTick, tick: snapDown(rawTick, snapDraw(e)), midi, hit, onEdge, ghost };
}

function onPointerMove(e) {
  if (e.pointerType === "touch") { onTouchMove(e); return; }
  hoverPt = { clientX: e.clientX, clientY: e.clientY };
  if (drag) { onDragMove(e); return; }

  if (pend) {
    if (Math.hypot(e.clientX - pend.x0, e.clientY - pend.y0) > MARQUEE_SLOP) startMarquee(e);
    return;
  }

  if (audition) {
    const k = keyAt(e);
    if (k !== null) startAudition(k, audition.pid);
    return;
  }

  if (onHeadMeter(e)) {
    cv.style.cursor = "context-menu";
    if (hover || markCursor !== null) { hover = null; markCursor = null; draw(); }
    return;
  }

  if (keyAt(e) !== null) {
    cv.style.cursor = sounding() ? "default" : "pointer";
    if (hover || markCursor !== null) { hover = null; markCursor = null; draw(); }
    return;
  }

  const rt = rulerTick(e);
  if (rt !== null) {
    cv.style.cursor = "col-resize";
    if (rt !== markCursor || hover) { markCursor = rt; hover = null; draw(); }
    return;
  }
  const at = song ? locate(e) : null;

  if (at?.ghost) {
    cv.style.cursor = "alias";
    if (hover || markCursor !== null) { hover = null; markCursor = null; draw(); }
    return;
  }

  const onBlank = at && !at.hit && tool === "select";
  if (onBlank) {
    cv.style.cursor = "default";
    const t = markTickAt(e);
    if (t !== markCursor || hover) { markCursor = t; hover = null; draw(); }
    return;
  }
  if (markCursor !== null) { markCursor = null; draw(); }

  cv.style.cursor = !at || !canEdit() ? "default"
    : at.hit ? (at.onEdge ? "col-resize" : "move")
    : "default";

  const next = at && !at.hit && canDraw() ? { tick: at.tick, midi: at.midi } : null;
  if (next?.tick === hover?.tick && next?.midi === hover?.midi) return;
  hover = next;
  draw();
}

let lastDownTouch = false;

function onContextMenu(e) {
  e.preventDefault();
  if (lastDownTouch) return;
  if (onHeadMeter(e)) { onMeterMenu({ x: e.clientX, y: e.clientY }); return; }
  openMenu(e.clientX, e.clientY);
}

function openMenu(cx, cy) {
  const e = { clientX: cx, clientY: cy };

  if (onHeadMeter(e)) { onMeterMenu({ x: cx, y: cy }); return; }

  const rt = rulerTick(e);
  if (rt !== null) {
    onBarMenu({
      x: cx, y: cy,
      markTick: rt,
      barTick: barStartTick(barIndexOf(rt)),
      bar: barIndexOf(rt),
      canEdit: canEdit(),
      whyNot: canEdit() ? "" : whyNot,
    });
    return;
  }

  if (!song) return;

  const at = locate(e);
  if (!at) return;

  if (at.hit) {
    if (!selKeys.has(selKey(at.hit.tick, at.hit.midi))) onPick(at.hit);
    onNoteMenu({
      x: e.clientX, y: e.clientY,
      note: { tick: at.hit.tick, midi: at.hit.midi, dur: at.hit.durTick },
      canEdit: canEdit(),
      whyNot: canEdit() ? "" : whyNot,
    });
    return;
  }

  onRollMenu({
    x: e.clientX, y: e.clientY,
    markTick: markTickAt(e),
    pasteTick: markTickRaw(e),
    barTick: barStartTick(barIndexOf(markTickAt(e))),
    canEdit: canEdit(),
    whyNot: canEdit() ? "" : whyNot,
  });
}

export function setTimeSigUI(on) {
  const v = !!on;
  if (v === timeSigUI) return;
  timeSigUI = v;
  draw();
}

export function setEditable(ok, reason = "") {
  editable = ok;
  whyNot = ok ? "" : reason;
  if (!ok) { hover = null; drag = null; pend = null; }
  syncToolbar();
  draw();
}

export function setNonstd(n, zipped = false) {
  nonstdN = n | 0;
  nonstdZip = !!zipped;
  syncToolbar();
}

export function setBadNotes(keys, bars = [], note = "") {
  badKeys = new Set(keys);
  badBars = new Set(bars);
  badNote = badKeys.size || badBars.size ? note : "";
  syncToolbar();
  draw();
}

export const noteLength = () => noteLen;
export const noteDotted = () => noteDot;

export const isFollowing = () => follow;

function setFollow(on) {
  follow = on;
  syncToolbar();
  if (on) {
    const t = guideTick();
    if (t !== null) followGuide(t, box.clientWidth);
  }
}

function initToolbar() {
  const fb = document.getElementById("followBtn");
  if (fb) fb.addEventListener("click", () => setFollow(!follow));

  const rs = document.getElementById("rangeSel");
  if (rs) rs.addEventListener("click", e => {
    const b = e.target.closest("button[data-range]");
    if (b && b.dataset.range === "all") clearMarks();
  });
  syncRange();

  const sel = document.getElementById("toolSelect");
  if (sel) sel.addEventListener("click", pickSelect);

  const zg = document.getElementById("zoom");
  if (zg) {
    zg.addEventListener("click", e => {
      const b = e.target.closest("button[data-zoom]");
      if (!b) return;
      stepZoom(b.dataset.zoom[0], b.dataset.zoom[1] === "+" ? 1 : -1);
    });
    for (const b of zg.querySelectorAll("button[data-zoom]"))
      b.title = i18n.t(`roll.zoom.${b.dataset.zoom[0]}${b.dataset.zoom[1] === "+" ? "In" : "Out"}`);
  }

  document.getElementById("lensLbl")?.addEventListener("click", toggleNoteDot);

  const wrap = document.getElementById("lens");
  if (!wrap) return;
  wrap.addEventListener("click", e => {
    const b = e.target.closest("button[data-len]");
    if (b) setNoteLength(+b.dataset.len);
  });
  addEventListener("keydown", e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (editing(e.target)) return;
    if (document.querySelector(MODAL_SEL)) return;
    if (e.key === "0") { pickSelect(); e.preventDefault(); return; }
    const i = "1234567".indexOf(e.key);
    if (i >= 0) { setNoteLength([1, 2, 4, 8, 16, 32, 64][i]); e.preventDefault(); }
  });
  syncToolbar();
}

function fineHint() {
  if (!drag || drag.mode === "marquee") return "";
  return i18n.t(drag.mode === "resize" ? "roll.fineResize" : "roll.fineMove");
}

function effectMsg() {
  const eff = drag?.effect;
  if (!eff) return "";
  const parts = [];
  if (eff.nKill) parts.push(i18n.t("roll.willDelete", { n: eff.nKill }));
  if (eff.nTrim) parts.push(i18n.t("roll.willTrim", { n: eff.nTrim }));
  return parts.join(" · ");
}

function pickSelect() {
  if (tool === "select") return;
  if (drag?.mode === "create") endDrag(false);
  tool = "select";
  hover = null;
  syncToolbar();
  draw();
}

function setNoteLength(n) {
  if (drag?.mode === "create") endDrag(false);
  noteLen = n;
  if (n === 64) noteDot = false;
  tool = "draw";
  markCursor = null;
  syncToolbar();
  draw();
}

function toggleNoteDot() {
  if (tool !== "draw") return;
  if (noteLen === 64) { say(i18n.t("roll.len.noDot64")); return; }
  if (drag?.mode === "create") endDrag(false);
  noteDot = !noteDot;
  syncToolbar();
  draw();
}

function syncLensIcon() {
  const b = document.getElementById("lensLbl");
  if (!b) return;
  const drawing = tool === "draw";
  b.classList.toggle("sel", !drawing);
  b.disabled = !drawing;
  b.setAttribute("aria-pressed", String(noteDot));

  const use = b.querySelector("use");
  if (use) use.setAttribute("href", `#ni-${noteLen}${noteDot ? "d" : ""}`);

  const name = b.querySelector(".sr");
  if (name) {
    const len = i18n.t(`roll.len.n${noteLen}`);
    name.textContent = !drawing ? i18n.t("roll.len.idle")
      : noteDot ? i18n.t("roll.len.dotted", { name: len }) : len;
  }
  b.title = drawing
    ? i18n.t(noteLen === 64 ? "roll.len.noDot64" : "roll.len.toggle")
    : "";
}

function syncToolbar() {
  syncJoy();

  const sel = document.getElementById("toolSelect");
  if (sel) sel.classList.toggle("on", tool === "select");
  document.querySelectorAll("#lens button[data-len]").forEach(b => {
    b.classList.toggle("on", tool === "draw" && +b.dataset.len === noteLen);
  });
  syncLensIcon();

  document.querySelectorAll("#zoom button[data-zoom]").forEach(b => {
    const w = b.dataset.zoom[0] === "w";
    const dir = b.dataset.zoom[1] === "+" ? 1 : -1;
    b.disabled = zoomStep(w ? ZOOM_W : ZOOM_H, w ? CELL_W : ROW_H, dir) === null;
  });

  const t = document.getElementById("rollTrack");
  if (t) {
    t.textContent = i18n.trackName(active);
    t.style.color = TRACK_COLORS[active];
  }

  const mode = document.getElementById("rollMode");
  if (mode) {
    const paused = player.isPlaying() && player.isPaused();
    mode.textContent = i18n.t(sounding() ? "roll.mode.playing"
      : paused ? "roll.mode.paused" : "roll.mode.editing");
    mode.classList.toggle("playing", sounding());
  }
  const fb = document.getElementById("followBtn");
  if (fb) fb.classList.toggle("on", follow);

  const note = document.getElementById("rollNote");
  if (note) {
    const msg = whyNot || effectMsg() || badNote;
    note.textContent = msg;
    note.classList.toggle("on", !!msg);
  }
  const ns = document.getElementById("rollNonstd");
  if (ns) {
    const show = nonstdN > 0 && !whyNot && !!onNonstdFix;
    ns.hidden = !show;
    if (show) {
      ns.textContent = "";
      const txt = document.createElement("span");
      txt.textContent = i18n.t("ui.nonstd.warn", { n: nonstdN });
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = i18n.t("ui.nonstd.fixBtn");
      btn.title = i18n.t("ui.nonstd.fixHint");
      btn.addEventListener("click", () => onNonstdFix());
      ns.append(txt, btn);
      if (nonstdZip) {
        const zipTxt = document.createElement("span");
        zipTxt.className = "zipnote";
        zipTxt.textContent = i18n.t("ui.nonstd.zipHint");
        ns.append(zipTxt);
      }
    }
  }

  const warn = effectMsg();
  if (warn) rolljoy.setEffect(warn);
  else rolljoy.setEffect(marqueeArmed() ? i18n.t("roll.pad.multiHint") : "", "note");
  document.querySelectorAll("#lens button[data-len]").forEach(b => { b.disabled = !editable; });
  if (sel) sel.disabled = !editable;

  const hint = document.getElementById("rollHint");
  if (hint) {
    const paused = player.isPlaying() && player.isPaused();
    hint.textContent = (sounding()
      ? i18n.t("roll.hint.playingReadonly")
      : i18n.t(tool === "draw" ? "roll.hint.edit" : "roll.hint.editNoDraw") + fineHint())
      + (paused && !sounding() ? i18n.t("roll.hint.pausedSuffix") : "");
    hint.classList.toggle("keep", sounding() || paused);
  }
}
