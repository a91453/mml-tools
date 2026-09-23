// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Touch nudge pad for the piano roll.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import * as i18n from "./i18n.mjs";
import { icon as iconMarkup } from "./icons.mjs";

export const DEAD = 0.18;

export const MAX_SPEED_SIZE = 35;

const SIZE_R = 52;

export const HOLD_MS = 300;
export const REP_FINE = 180;

let el = null;
let warnEl = null;
let multiBtn = null;
let sizePad = null;
let axes = [];
let steps = [];
let raf = 0;
let hooks = {};

export const throttle = (mag, dead) => (mag <= dead ? 0 : (mag - dead) / (1 - dead));

export const speed = (m, max) => max * m * m * m;

export const isOpen = () => !!el;

export const top = () => (el ? el.getBoundingClientRect().top : Infinity);

export function init(h) {
  hooks = h ?? {};
}

export function show({ canResize = true, multi = false } = {}) {
  if (!el) build();
  sizePad.classList.toggle("off", !canResize);
  multiBtn.classList.toggle("on", multi);
  multiBtn.setAttribute("aria-pressed", String(multi));
}

export function hide() {
  if (!el) return;
  stopAll();
  el.remove();
  el = null; warnEl = null; multiBtn = null; sizePad = null;
  axes = []; steps = [];
}

export function setEffect(msg, tone = "warn") {
  if (!warnEl) return;
  warnEl.textContent = msg || "";
  warnEl.classList.toggle("on", !!msg);
  warnEl.classList.toggle("note", !!msg && tone === "note");
}

export function place() {
  if (!el) return;
  const st = document.getElementById("status");
  const shown = st && st.offsetParent !== null;
  const gap = shown ? Math.max(0, innerHeight - st.getBoundingClientRect().top) : 0;
  el.style.bottom = `${Math.round(gap)}px`;
}

function build() {
  el = document.createElement("div");
  el.id = "rollJoy";

  warnEl = document.createElement("div");
  warnEl.className = "warn";
  el.appendChild(warnEl);

  const ctl = document.createElement("div");
  ctl.className = "ctl";
  el.appendChild(ctl);

  ctl.appendChild(buildDpad());

  const right = document.createElement("div");
  right.className = "right";
  ctl.appendChild(right);

  const keys = document.createElement("div");
  keys.className = "keys";
  right.appendChild(keys);

  multiBtn = mkKey(i18n.t("roll.pad.multi"), "chart-gantt", "multi");
  multiBtn.setAttribute("aria-pressed", "false");
  multiBtn.addEventListener("click", () => {
    const on = !multiBtn.classList.contains("on");
    multiBtn.classList.toggle("on", on);
    multiBtn.setAttribute("aria-pressed", String(on));
    hooks.onMulti?.(on);
  });
  keys.appendChild(multiBtn);

  const menuBtn = mkKey("☰ " + i18n.t("roll.pad.menu"), null, "menu");
  menuBtn.addEventListener("click", () => {
    const r = menuBtn.getBoundingClientRect();
    hooks.onMenu?.(r.left + r.width / 2, r.top);
  });
  keys.appendChild(menuBtn);

  sizePad = document.createElement("div");
  sizePad.className = "size pad";
  sizePad.setAttribute("role", "application");
  sizePad.setAttribute("aria-label", i18n.t("roll.pad.size"));
  sizePad.innerHTML = '<span class="knob"></span>';
  right.appendChild(sizePad);

  const exits = document.createElement("div");
  exits.className = "keys exits";
  right.appendChild(exits);

  const clearBtn = mkKey(i18n.t("roll.pad.clear"), null, "clear");
  clearBtn.addEventListener("click", () => hooks.onClear?.());
  exits.appendChild(clearBtn);

  const delBtn = mkKey(i18n.t("roll.pad.del"), null, "del");
  delBtn.classList.add("del");
  delBtn.addEventListener("click", () => hooks.onDelete?.());
  exits.appendChild(delBtn);

  document.body.appendChild(el);

  axes = [
    bindAxis(sizePad, { kind: "size", maxR: SIZE_R, dead: DEAD, lockY: true, max: MAX_SPEED_SIZE }),
  ];
}

function buildDpad() {
  const fit = document.createElement("div");
  fit.className = "dpad-fit";
  fit.setAttribute("aria-hidden", "true");

  const wrap = document.createElement("div");
  wrap.className = "dpad-wrap";
  fit.appendChild(wrap);

  steps = [];
  for (const dir of ["up", "down", "left", "right"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `key-d ${dir}`;
    b.tabIndex = -1;
    wrap.appendChild(b);
    steps.push(bindStep(b, dir));
  }
  return fit;
}

function bindStep(btn, dir) {
  let hold = 0, rep = 0;
  const stop = () => {
    const wasDown = !!(hold || rep);
    clearTimeout(hold); clearInterval(rep);
    hold = 0; rep = 0;
    btn.classList.remove("on");
    if (wasDown) hooks.onStepEnd?.();
  };
  btn.addEventListener("pointerdown", e => {
    if (hold || rep) return;
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch {  }
    btn.classList.add("on");
    hooks.onStep?.(dir);
    hold = setTimeout(() => { rep = setInterval(() => hooks.onStep?.(dir), REP_FINE); }, HOLD_MS);
  });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(t, stop);
  return stop;
}

function mkKey(text, icon, k) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "key";
  if (k) b.setAttribute("data-k", k);
  if (icon) b.insertAdjacentHTML("beforeend", iconMarkup(icon));
  b.appendChild(document.createTextNode(text));
  return b;
}

function bindAxis(pad, { kind, maxR, dead, lockY, max }) {
  const knob = pad.querySelector(".knob");
  const a = { kind, pad, knob, maxR, dead, lockY, max, pid: null, ux: 0, uy: 0, mag: 0 };

  pad.addEventListener("pointerdown", e => {
    if (a.pid !== null || pad.classList.contains("off")) return;
    if (axes.some(x => x.pid !== null)) return;
    a.pid = e.pointerId;
    try { pad.setPointerCapture(a.pid); } catch {  }
    pad.classList.add("active");
    hooks.onStart?.(kind);
    move(e);
    startLoop();
  });
  pad.addEventListener("pointermove", e => { if (e.pointerId === a.pid) move(e); });
  for (const t of ["pointerup", "pointercancel"]) {
    pad.addEventListener(t, e => {
      if (e.pointerId !== a.pid) return;
      release(a);
      hooks.onEnd?.(kind);
    });
  }

  function move(e) {
    const r = pad.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = lockY ? 0 : e.clientY - (r.top + r.height / 2);

    const dist = Math.hypot(dx, dy);
    if (dist > maxR) { dx = dx / dist * maxR; dy = dy / dist * maxR; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;

    const len = Math.hypot(dx, dy);
    const m = throttle(Math.min(len / maxR, 1), dead);
    if (!m) { a.mag = 0; a.ux = 0; a.uy = 0; return; }
    a.mag = m;
    a.ux = dx / len;
    a.uy = dy / len;
  }

  return a;
}

function release(a) {
  if (a.pid === null) return;
  try { a.pad.releasePointerCapture(a.pid); } catch {  }
  a.pid = null;
  a.mag = 0; a.ux = 0; a.uy = 0;
  a.pad.classList.remove("active");
  a.knob.style.transform = "translate(0,0)";
}

function stopAll() {
  for (const a of axes) release(a);
  for (const stop of steps) stop();
  if (raf) cancelAnimationFrame(raf);
  raf = 0; last = 0;
}

function startLoop() {
  if (!raf) { last = 0; raf = requestAnimationFrame(loop); }
}

let last = 0;
function loop(now) {
  raf = 0;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
  last = now;

  let live = false;
  for (const a of axes) {
    if (a.pid === null) continue;
    live = true;
    if (!a.mag || !dt) continue;
    const v = speed(a.mag, a.max) * dt;
    hooks.onMove?.(a.kind, a.ux * v, a.uy * v);
  }
  if (live) raf = requestAnimationFrame(loop);
  else last = 0;
}
