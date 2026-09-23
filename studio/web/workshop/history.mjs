// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Undo/redo snapshot history.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
const LIMIT = 80;
const TYPING_IDLE = 400;

let take = () => null;
let put = () => {};
let same = (a, b) => a === b;
let onApply = () => {};
let onChange = () => {};

const undoStack = [];
const redoStack = [];

let shadow = null;
let burstBase = null;
let burstTimer = null;

export const canUndo = () => undoStack.length > 0 || burstTimer !== null;
export const canRedo = () => redoStack.length > 0 && burstTimer === null;

export function init(h) {
  take = h.snapshot;
  put = h.restore;
  same = h.equal ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b));
  onApply = h.onApply ?? onApply;
  onChange = h.onChange ?? onChange;
  reset();

  if (typeof addEventListener === "function") {
    addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    });
  }
}

export function edit(fn) {
  flushTyping();
  const before = take();
  fn();
  const after = take();
  if (!same(before, after)) push(before);
  shadow = after;
  onChange();
}

export function typed() {
  const opening = burstTimer === null;
  if (opening) burstBase = shadow;
  clearTimeout(burstTimer);
  burstTimer = setTimeout(flushTyping, TYPING_IDLE);
  if (opening) onChange();
}

export function flushTyping() {
  if (burstTimer === null) return;
  clearTimeout(burstTimer);
  burstTimer = null;
  const now = take();
  if (burstBase !== null && !same(burstBase, now)) push(burstBase);
  shadow = now;
  burstBase = null;
  onChange();
}

function push(state) {
  undoStack.push(state);
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0;
}

export function undo() {
  flushTyping();
  if (!undoStack.length) return false;
  const now = take();
  const prev = undoStack.pop();
  redoStack.push(now);
  shadow = prev;
  put(prev);
  onApply();
  onChange();
  return true;
}

export function redo() {
  flushTyping();
  if (!redoStack.length) return false;
  const now = take();
  const next = redoStack.pop();
  undoStack.push(now);
  shadow = next;
  put(next);
  onApply();
  onChange();
  return true;
}

export function reset() {
  clearTimeout(burstTimer);
  burstTimer = null;
  burstBase = null;
  undoStack.length = 0;
  redoStack.length = 0;
  shadow = take();
  onChange();
}

export function _debug() {
  return { undo: undoStack.length, redo: redoStack.length, pending: burstTimer !== null };
}
