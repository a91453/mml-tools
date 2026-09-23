// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Piano-roll context menu.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
let el = null;
let rows = [];
let restoreFocus = null;

export const isOpen = () => !!el;

export function close() {
  if (!el) return;
  removeEventListener("pointerdown", onOutside, true);
  removeEventListener("scroll", close, true);
  removeEventListener("resize", close);
  el.remove();
  el = null;
  rows = [];
  const back = restoreFocus;
  restoreFocus = null;
  if (back?.isConnected) back.focus();
}

function onOutside(e) {
  if (!el || el.contains(e.target)) return;
  e.stopPropagation();
  close();
}

export function open({ x, y, title = "", rows: list = [], a11y = {} }) {
  close();

  restoreFocus = document.activeElement;
  rows = list.filter(Boolean);

  el = document.createElement("div");
  el.id = "rollMenu";
  el.className = "on";
  el.setAttribute("role", "menu");
  if (a11y.menu) el.setAttribute("aria-label", a11y.menu);

  if (title) {
    const h = document.createElement("div");
    h.className = "head";
    h.textContent = title;
    el.appendChild(h);
  }

  for (const row of list) {
    if (!row) {
      el.appendChild(document.createElement("hr"));
      continue;
    }

    const r = document.createElement("div");
    r.className = "row" + (row.danger ? " danger" : "");
    r.dataset.id = row.id;

    const act = document.createElement("button");
    act.type = "button";
    act.className = "act";
    act.setAttribute("role", "menuitem");
    act.appendChild(document.createElement("b"));
    act.appendChild(document.createElement("span"));
    act.addEventListener("click", () => {
      if (act.disabled) return;
      const n = row.step?.value;
      close();
      row.run(n);
    });
    r.appendChild(act);

    if (row.step) {
      const spin = document.createElement("span");
      spin.className = "spin";
      const dec = mkArrow("◀", a11y.dec);
      const num = document.createElement("i");
      const inc = mkArrow("▶", a11y.inc);
      spin.append(dec, num, inc);
      dec.addEventListener("click", () => bump(row, -1));
      inc.addEventListener("click", () => bump(row, +1));
      r.appendChild(spin);
    }

    el.appendChild(r);
    paint(row, r);
  }

  document.body.appendChild(el);
  place(x, y);

  el.tabIndex = -1;
  el.focus({ preventScroll: true });

  addEventListener("pointerdown", onOutside, true);
  addEventListener("scroll", close, true);
  addEventListener("resize", close);
  el.addEventListener("keydown", onKey);
}

function mkArrow(glyph, label) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = glyph;
  if (label) b.setAttribute("aria-label", label);
  return b;
}

const items = () => el ? [...el.querySelectorAll(".row > .act")] : [];

function rowElOf(row) {
  return el?.querySelector(`.row[data-id="${row.id}"]`) ?? null;
}

const stepValues = s => (typeof s.values === "function" ? s.values() : s.values);

function nearestIndex(list, v) {
  let best = 0, gap = Infinity;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs(list[i] - v);
    if (d < gap) { gap = d; best = i; }
  }
  return best;
}

function bump(row, d) {
  const s = row.step;
  if (s.values) {
    const list = stepValues(s);
    if (!list.length) return;
    const next = list[Math.min(list.length - 1, Math.max(0, nearestIndex(list, s.value) + d))];
    if (next === s.value) return;
    s.value = next;
  } else {
    const next = Math.min(s.max, Math.max(s.min, s.value + d));
    if (next === s.value) return;
    s.value = next;
  }
  row.onChange?.(s.value);
  repaintAll();
}

function repaintAll() {
  for (const row of rows) {
    const r = rowElOf(row);
    if (r) paint(row, r);
  }
}

function paint(row, r) {
  const { label, hint = "", disabled = false, why = "" } = row.format(row.step?.value);
  const act = r.querySelector(".act");
  act.querySelector("b").textContent = label;
  act.querySelector("span").textContent = disabled && why ? why : hint;
  act.disabled = disabled;
  r.classList.toggle("off", disabled);

  if (!row.step) return;
  const s = row.step;
  const spin = r.querySelector(".spin");
  const [dec, inc] = spin.querySelectorAll("button");

  if (s.values) {
    const list = stepValues(s);
    if (list.length && !list.includes(s.value)) {
      s.value = list[nearestIndex(list, s.value)];
      row.onChange?.(s.value);
    }
    const i = list.indexOf(s.value);
    dec.disabled = i <= 0;
    inc.disabled = i < 0 || i >= list.length - 1;
  } else {
    dec.disabled = s.value <= s.min;
    inc.disabled = s.value >= s.max;
  }
  spin.querySelector("i").textContent = String(s.value);
}

function onKey(e) {
  if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(); return; }

  const list = items().filter(b => !b.disabled);
  if (!list.length) return;
  const cur = list.indexOf(document.activeElement);

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = (cur + step + list.length + (cur < 0 && step < 0 ? 1 : 0)) % list.length;
    list[next].focus();
    return;
  }

  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const rowEl = document.activeElement?.closest?.(".row");
    const row = rowEl && el?.contains(rowEl) ? rows.find(r => r.id === rowEl.dataset.id) : null;
    if (!row?.step) return;
    e.preventDefault();
    bump(row, e.key === "ArrowRight" ? 1 : -1);
    return;
  }

}

function place(x, y) {
  const m = 6;
  const w = el.offsetWidth, h = el.offsetHeight;
  const vw = innerWidth, vh = innerHeight;

  let left = x, top = y;
  if (left + w + m > vw) left = x - w;
  if (left < m) left = Math.max(m, vw - w - m);
  if (top + h + m > vh) top = y - h;
  if (top < m) top = Math.max(m, vh - h - m);

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}
