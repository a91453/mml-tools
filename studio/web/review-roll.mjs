// Six-role review roll: a read-only, virtualised canvas view of the analysed
// candidate.
//
// Rendering and input are ported from the owner's MML 工房 `pianoroll.js`
// (frontend capture f1b7024f…baad9a, owner authorization 2026-09-23):
//   * one viewport-sized canvas, `position: sticky` inside a native scroll
//     container, with an empty spacer sized to the whole song. A song-sized
//     canvas would be hundreds of MB at devicePixelRatio 2;
//   * paint only the visible beats and rows, one Path2D per line style;
//   * a re-entrancy guard around paint;
//   * Ctrl/⌘+wheel zooms time, Ctrl+Shift or Alt+wheel zooms pitch, deltas
//     normalised and accumulated so a trackpad does not skip every step;
//   * touch: one finger waits, pans past TAP_SLOP, taps otherwise; two fingers
//     pinch ONE axis, decided on the first real spread and locked until release;
//   * a fingertip that misses takes the nearest note within HIT_RADIUS;
//   * theme colours read from CSS custom properties once per mount, because a
//     canvas cannot see CSS variables.
//
// Deliberately different from MML 工房, because this is a review surface:
//   * nothing here edits. A click selects an EVENT ID and reports it; there is
//     no draw, move, resize, delete, paste or nudge, and no implicit commit;
//   * lanes are the six Canonical roles: Core3 (Melody, Chord1, Chord2) solid,
//     Chord3–Chord5 outlined, unassigned pitched material hatched — never
//     hidden to make the page look complete;
//   * harmony conflicts are amber review signals (MASTER_RULES §6: overlap is a
//     review signal, not a deletion target) that link to their arbitration
//     form; nothing is painted as "wrong";
//   * time stays exact until the pixel; see roll-geometry.mjs.
import {
  DEFAULT_ZOOM, GUTTER_W, HIT_RADIUS, OFFICIAL_PITCH_MAX, RULER_H, ROLL_ROLES, TAP_SLOP, WHEEL_STEP, ZOOM_H, ZOOM_W,
  barStarts, beatDivisions, beatNumber, beatToX, contentSize, eachEvent, hitTest, isBlackKey, laneTier, pinchAxis,
  pitchName, pitchSpan, pitchToY, prepareProjection, visibleBeats, wheelPixels, zoomScroll, zoomStep, zoomTick,
} from './roll-geometry.mjs';

// View preferences survive re-renders of the page (every commit re-renders).
const prefs = { w: DEFAULT_ZOOM.w, h: DEFAULT_ZOOM.h, visible: [true, true, true, true, true, true, true] };

const TOKENS = ['bg', 'row-white', 'row-black', 'row-out', 'grid', 'beat', 'bar', 'ruler-bg', 'text', 'muted', 'lane-0', 'lane-1', 'lane-2', 'lane-3', 'lane-4', 'lane-5', 'lane-6', 'signal', 'signal-line', 'select'];
function readTheme(element) {
  const style = getComputedStyle(element);
  return Object.fromEntries(TOKENS.map(name => [name, style.getPropertyValue(`--roll-${name}`).trim() || '#888']));
}

export function mountReviewRoll(root, source, { onSelect = () => {}, onSignal = () => {}, marked: initiallyMarked = [] } = {}) {
  const projection = prepareProjection(source);
  root.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'roll-stage';
  stage.tabIndex = 0;
  stage.setAttribute('aria-label', '六角色審核捲軸（唯讀）。Ctrl＋滾輪縮放時間，Alt＋滾輪縮放音高。');
  const canvas = document.createElement('canvas');
  canvas.className = 'roll-canvas';
  canvas.setAttribute('role', 'img');
  const pad = document.createElement('div');
  pad.className = 'roll-pad';
  stage.append(canvas, pad);
  root.append(stage);
  const g = canvas.getContext('2d');
  const C = readTheme(root);
  const span = pitchSpan(projection);
  const bars = barStarts(projection.meters, projection.end).map(b => ({ ...b, x: beatNumber(b.beat) }));
  const eventsById = new Map();
  for (const { lane, event } of eachEvent(projection)) eventsById.set(event.id, { lane, event });
  const signalsByEvent = new Map();
  for (const signal of projection.signals) for (const id of signal.eventIds) signalsByEvent.set(id, [...(signalsByEvent.get(id) ?? []), signal]);
  let selected = null;
  let focusedSignal = null;
  // Events gathered by the Decision Composer: outlined, never edited here.
  let marked = new Set(initiallyMarked);
  let drawing = false;
  const counts = projection.lanes.map(l => l.events.length);
  canvas.setAttribute('aria-label', `${ROLL_ROLES.map((r, i) => `${r} ${counts[i]}`).join('、')}、未指派 ${projection.unassigned.length} 個音符；${projection.signals.length} 個審核訊號。`);

  const view = () => ({ pxPerBeat: prefs.w, rowH: prefs.h, scrollX: stage.scrollLeft, scrollY: stage.scrollTop, width: stage.clientWidth, height: stage.clientHeight, low: span.low, high: span.high });
  function syncPad() {
    const size = contentSize(view(), projection.end);
    pad.style.width = `${size.width}px`;
    pad.style.height = `${size.height}px`;
  }

  function resize(W, H) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    if (drawing) return;
    drawing = true;
    try { paint(); } finally { drawing = false; }
  }

  function paint() {
    const v = view();
    const W = v.width, H = v.height;
    if (!W || !H) return;
    if (W !== parseFloat(canvas.style.width) || H !== parseFloat(canvas.style.height)) resize(W, H);
    g.clearRect(0, 0, W, H);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    const { from, to } = visibleBeats(v);
    const rowTop = Math.max(span.low, span.high - Math.ceil((v.scrollY + H) / v.rowH));
    const rowBottom = Math.min(span.high, span.high - Math.floor(v.scrollY / v.rowH) + 1);

    // rows: black keys darker, pitches above the official 0–107 range shaded
    for (let pitch = rowTop; pitch <= rowBottom; pitch++) {
      g.fillStyle = pitch > OFFICIAL_PITCH_MAX ? C['row-out'] : isBlackKey(pitch) ? C['row-black'] : C['row-white'];
      g.fillRect(GUTTER_W, pitchToY(v, pitch), W - GUTTER_W, v.rowH);
    }

    // review-signal bands sit under the grid and notes: background information
    g.fillStyle = C.signal;
    for (const signal of projection.signals) {
      if (signal.f < from || signal.s > to) continue;
      const x0 = Math.max(GUTTER_W, beatToX(v, signal.s));
      const x1 = Math.min(W, Math.max(x0 + 3, beatToX(v, signal.f)));
      g.globalAlpha = signal === focusedSignal ? 0.55 : signal.kind !== 'harmony' || signal.resolved ? 0.12 : 0.28;
      g.fillRect(x0, RULER_H, x1 - x0, H - RULER_H);
    }
    g.globalAlpha = 1;

    drawGrid(v, W, H, from, to);
    drawNotes(v, W, H, from, to);
    drawKeyboard(v, H, rowTop, rowBottom);
    drawRuler(v, W, from, to);
  }

  function drawGrid(v, W, H, from, to) {
    const bottom = Math.min(H, pitchToY(v, span.low) + v.rowH);
    const divisions = beatDivisions(v.pxPerBeat);
    const sub = new Path2D(), beat = new Path2D(), bar = new Path2D();
    for (let k = Math.floor(from * divisions); k <= Math.ceil(to * divisions); k++) {
      const x = Math.round(GUTTER_W + (k / divisions) * v.pxPerBeat - v.scrollX) + 0.5;
      if (x < GUTTER_W) continue;
      const path = k % divisions === 0 ? beat : sub;
      path.moveTo(x, RULER_H); path.lineTo(x, bottom);
    }
    for (const b of bars) {
      if (b.x < from - 1 || b.x > to + 1) continue;
      const x = Math.round(beatToX(v, b.x)) + 0.5;
      if (x < GUTTER_W) continue;
      bar.moveTo(x, RULER_H); bar.lineTo(x, bottom);
    }
    g.lineWidth = 1;
    g.strokeStyle = C.grid; g.stroke(sub);
    g.strokeStyle = C.beat; g.stroke(beat);
    g.strokeStyle = C.bar; g.stroke(bar);
  }

  function noteRect(v, event) {
    const x0 = beatToX(v, event.s);
    const x1 = Math.max(x0 + 2, beatToX(v, event.f));
    return { x: x0, y: pitchToY(v, event.pitch), w: x1 - x0, h: v.rowH };
  }

  function drawNotes(v, W, H, from, to) {
    // Paint order: unassigned, enrichment, Core3, then the selected lane on
    // top, so Core3 is never hidden under enrichment.
    const order = [6, 5, 4, 3, 2, 1, 0];
    if (selected) order.push(selected.lane);
    const done = new Set();
    for (const lane of order) {
      if (!prefs.visible[lane]) continue;
      const events = lane < 6 ? projection.lanes[lane].events : projection.unassigned;
      const colour = C[`lane-${lane}`];
      const tier = laneTier(lane);
      for (const event of events) {
        if (event.f < from || event.s > to) continue;
        const key = `${lane}:${event.id}`;
        if (done.has(key) && !(selected && selected.lane === lane)) continue;
        done.add(key);
        const r = noteRect(v, event);
        if (r.x > W || r.x + r.w < GUTTER_W || r.y > H || r.y + r.h < RULER_H) continue;
        const inset = r.h > 5 ? 0.5 : 0;
        if (tier === 'core') {
          g.fillStyle = colour;
          g.fillRect(r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2);
        } else if (tier === 'enrichment') {
          g.globalAlpha = 0.22; g.fillStyle = colour; g.fillRect(r.x, r.y, r.w, r.h); g.globalAlpha = 1;
          g.strokeStyle = colour; g.lineWidth = 1.5;
          g.strokeRect(r.x + 0.75, r.y + 0.75, Math.max(1, r.w - 1.5), Math.max(1, r.h - 1.5));
        } else {
          g.save();
          g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
          g.strokeStyle = colour; g.lineWidth = 1;
          for (let k = -r.h; k < r.w; k += 4) { g.beginPath(); g.moveTo(r.x + k, r.y + r.h); g.lineTo(r.x + k + r.h, r.y); g.stroke(); }
          g.restore();
          g.strokeStyle = colour; g.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
        }
        if (event.pitch > OFFICIAL_PITCH_MAX) { g.fillStyle = C['signal-line']; g.fillRect(r.x, r.y, 3, r.h); }
        if (signalsByEvent.has(event.id)) {
          g.strokeStyle = C['signal-line']; g.lineWidth = 2;
          g.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
        }
        if (selected && selected.id === event.id) {
          g.strokeStyle = C.select; g.lineWidth = 2;
          g.strokeRect(r.x - 2.5, r.y - 2.5, r.w + 5, r.h + 5);
        } else if (marked.has(event.id)) {
          g.setLineDash([3, 2]); g.strokeStyle = C.select; g.lineWidth = 1.5;
          g.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
          g.setLineDash([]);
        }
      }
    }
  }

  function drawKeyboard(v, H, rowTop, rowBottom) {
    g.fillStyle = C['ruler-bg'];
    g.fillRect(0, RULER_H, GUTTER_W, H - RULER_H);
    g.font = '10px ui-monospace,SFMono-Regular,Consolas,monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let pitch = rowTop; pitch <= rowBottom; pitch++) {
      const y = pitchToY(v, pitch);
      if (isBlackKey(pitch)) { g.fillStyle = C['row-black']; g.fillRect(GUTTER_W - 14, y, 14, v.rowH); }
      if (pitch % 12 === 0) {
        g.fillStyle = C.bar; g.fillRect(0, Math.round(y + v.rowH) - 0.5, GUTTER_W, 1);
        g.fillStyle = C.text;
        g.textBaseline = 'bottom';
        g.fillText(pitchName(pitch), 4, Math.round(y + v.rowH) - 2);
      }
    }
  }

  function drawRuler(v, W, from, to) {
    g.fillStyle = C['ruler-bg'];
    g.fillRect(0, 0, W, RULER_H);
    g.font = '10px ui-monospace,SFMono-Regular,Consolas,monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    if (!bars.length) {
      g.fillStyle = C.muted;
      g.fillText('拍號未確認：只顯示拍線', GUTTER_W + 6, RULER_H / 2);
    }
    let lastRight = -Infinity;
    for (const b of bars) {
      if (b.x < from - 8 || b.x > to) continue;
      const x = beatToX(v, b.x);
      if (x < GUTTER_W) continue;
      const label = b.changed ? `${b.index + 1} ${b.numerator}/${b.denominator}` : String(b.index + 1);
      const width = g.measureText(label).width;
      if (x + 3 < lastRight + 4) continue;
      g.fillStyle = b.changed ? C.text : C.muted;
      g.fillText(label, x + 3, RULER_H / 2);
      lastRight = x + 3 + width;
    }
    // signal markers on the ruler, clickable through hitSignal()
    g.fillStyle = C['signal-line'];
    for (const signal of projection.signals) {
      if (signal.s < from || signal.s > to) continue;
      const x = Math.max(GUTTER_W, beatToX(v, signal.s));
      g.globalAlpha = signal.resolved ? 0.4 : 1;
      g.beginPath();
      // ▼ harmony, ◆ same-pitch overlap, ■ low-register crowding: shape, not
      // only colour, tells the kinds apart.
      if (signal.kind === 'overlap') { g.moveTo(x, RULER_H - 1); g.lineTo(x + 4, RULER_H - 5); g.lineTo(x, RULER_H - 9); g.lineTo(x - 4, RULER_H - 5); }
      else if (signal.kind === 'crowding') g.rect(x - 3, RULER_H - 8, 6, 6);
      else { g.moveTo(x, RULER_H); g.lineTo(x + 5, RULER_H - 7); g.lineTo(x - 5, RULER_H - 7); }
      g.closePath(); g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = C['ruler-bg'];
    g.fillRect(0, 0, GUTTER_W, RULER_H);
    g.fillStyle = C.muted;
    g.fillText('beat', 6, RULER_H / 2);
  }

  function hitSignal(x) {
    const v = view();
    return projection.signals.find(signal => Math.abs(Math.max(GUTTER_W, beatToX(v, signal.s)) - x) <= 7) ?? null;
  }

  // ─── selection (read-only) ──────────────────────────────────────────────
  function select(hit) {
    selected = hit;
    focusedSignal = null;
    draw();
    if (!hit) return onSelect(null);
    const { lane, event } = eventsById.get(hit.id);
    onSelect({ id: event.id, lane, role: lane < 6 ? ROLL_ROLES[lane] : null, pitch: event.pitch, pitchName: pitchName(event.pitch), start: event.start, end: event.end, signals: signalsByEvent.get(event.id) ?? [] });
  }
  function focusSignal(signal) {
    focusedSignal = signal;
    draw();
    onSignal(signal);
  }
  function pointAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }
  function tapAt(clientX, clientY, radius) {
    const { x, y } = pointAt(clientX, clientY);
    if (y < RULER_H) { const signal = hitSignal(x); if (signal) focusSignal(signal); return; }
    select(hitTest(projection, view(), x, y, { visible: prefs.visible, radius }));
  }

  // ─── zoom ───────────────────────────────────────────────────────────────
  function setZoom(axis, next, anchor) {
    if (next === null) return false;
    const W = stage.clientWidth, H = stage.clientHeight;
    const ax = Math.min(Math.max(anchor?.x ?? GUTTER_W + (W - GUTTER_W) / 2, GUTTER_W), W) - GUTTER_W;
    const ay = Math.min(Math.max(anchor?.y ?? RULER_H + (H - RULER_H) / 2, RULER_H), H) - RULER_H;
    if (axis === 'w') {
      const sx = zoomScroll(stage.scrollLeft, ax, prefs.w, next);
      prefs.w = next; syncPad(); stage.scrollLeft = sx;
    } else {
      const sy = zoomScroll(stage.scrollTop, ay, prefs.h, next);
      prefs.h = next; syncPad(); stage.scrollTop = sy;
    }
    draw();
    return true;
  }
  const stepZoom = (axis, dir, anchor) => setZoom(axis, zoomStep(axis === 'w' ? ZOOM_W : ZOOM_H, axis === 'w' ? prefs.w : prefs.h, dir), anchor);

  let wheelAcc = 0, wheelAxis = null;
  stage.addEventListener('wheel', event => {
    const zoomKey = event.ctrlKey || event.metaKey;
    const axis = zoomKey && event.shiftKey ? 'h' : event.altKey && !zoomKey ? 'h' : zoomKey ? 'w' : null;
    if (axis === null) return;
    event.preventDefault();
    const px = wheelPixels(event.deltaY, event.deltaMode, stage.clientHeight);
    if (axis !== wheelAxis || Math.sign(px) !== Math.sign(wheelAcc)) wheelAcc = 0;
    wheelAxis = axis;
    wheelAcc += px;
    const dir = px < 0 ? 1 : -1;
    const anchor = pointAt(event.clientX, event.clientY);
    while (Math.abs(wheelAcc) >= WHEEL_STEP) {
      wheelAcc -= Math.sign(wheelAcc) * WHEEL_STEP;
      if (!stepZoom(axis, dir, anchor)) { wheelAcc = 0; break; }
    }
  }, { passive: false });

  stage.addEventListener('keydown', event => {
    if (event.key === '+' || event.key === '=') { stepZoom(event.altKey ? 'h' : 'w', 1); event.preventDefault(); }
    else if (event.key === '-' || event.key === '_') { stepZoom(event.altKey ? 'h' : 'w', -1); event.preventDefault(); }
    else if (event.key === 'Escape') select(null);
  });

  // ─── pointer input: mouse clicks, touch pan / tap / one-axis pinch ─────
  const touches = new Map();
  let lastTouchTap = 0;
  let gesture = null;
  const centroid = () => { const p = [...touches.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };
  const spread = () => { const p = [...touches.values()]; return { x: Math.abs(p[0].x - p[1].x), y: Math.abs(p[0].y - p[1].y) }; };
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 1) gesture = { kind: 'pending', x0: event.clientX, y0: event.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
    else if (touches.size === 2) { const c = centroid(); gesture = { kind: 'pinch', axis: null, span0: spread(), ref: null, c0: c, sl: stage.scrollLeft, st: stage.scrollTop }; }
    stage.setPointerCapture?.(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch' || !touches.has(event.pointerId) || !gesture) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.kind === 'pending' || gesture.kind === 'pan') {
      const dx = event.clientX - gesture.x0, dy = event.clientY - gesture.y0;
      if (gesture.kind === 'pending' && Math.hypot(dx, dy) > TAP_SLOP) gesture.kind = 'pan';
      if (gesture.kind === 'pan') {
        stage.scrollLeft = gesture.sl - dx;
        // Studio is a long page, not a full-screen editor: once the roll's own
        // vertical scroll is at an edge, hand the rest of the drag to the page.
        const wanted = gesture.st - dy;
        stage.scrollTop = wanted;
        const overflow = wanted - stage.scrollTop;
        if (overflow !== (gesture.chained ?? 0)) { window.scrollBy(0, overflow - (gesture.chained ?? 0)); gesture.chained = overflow; }
      }
      return;
    }
    if (gesture.kind === 'pinch' && touches.size === 2) {
      const c = centroid(), s = spread();
      if (!gesture.axis) {
        gesture.axis = pinchAxis(s, gesture.span0, Math.hypot(c.x - gesture.c0.x, c.y - gesture.c0.y));
        if (gesture.axis) gesture.ref = gesture.axis === 'w' ? s.x : s.y;
        else { stage.scrollLeft = gesture.sl - (c.x - gesture.c0.x); stage.scrollTop = gesture.st - (c.y - gesture.c0.y); }
        return;
      }
      const current = gesture.axis === 'w' ? s.x : s.y;
      const dir = zoomTick(current, gesture.ref);
      if (dir && stepZoom(gesture.axis, dir, pointAt(c.x, c.y))) gesture.ref = current;
    }
  });
  const release = event => {
    if (event.pointerType !== 'touch' || !touches.has(event.pointerId)) return;
    touches.delete(event.pointerId);
    if (event.type === 'pointerup' && gesture?.kind === 'pending' && touches.size === 0) { lastTouchTap = Date.now(); tapAt(event.clientX, event.clientY, HIT_RADIUS); }
    if (touches.size === 0) gesture = null;
    else if (gesture?.kind === 'pinch') gesture = { kind: 'done' };
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  // Safari's click after a touch tap is a MouseEvent without pointerType; the
  // touch path already handled it, so a click right after a tap is ignored.
  stage.addEventListener('click', event => { if (event.pointerType !== 'touch' && Date.now() - lastTouchTap > 600) tapAt(event.clientX, event.clientY, 3); });

  stage.addEventListener('scroll', draw, { passive: true });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  observer?.observe(stage);

  syncPad();
  // Open at the first sounding note rather than at beat 0 of a long intro.
  let first = Infinity;
  for (const { event } of eachEvent(projection)) if (event.s < first) first = event.s;
  if (Number.isFinite(first)) stage.scrollLeft = Math.max(0, first * prefs.w - 2 * prefs.w);
  const firstTop = [...eachEvent(projection)].reduce((top, { event }) => Math.max(top, event.pitch), -Infinity);
  if (Number.isFinite(firstTop)) stage.scrollTop = Math.max(0, (span.high - firstTop - 4) * prefs.h);
  draw();

  return Object.freeze({
    draw,
    zoom: (axis, dir) => stepZoom(axis, dir),
    setLaneVisible(lane, visible) { prefs.visible[lane] = visible; draw(); },
    setMarked(ids) { marked = new Set(ids); draw(); },
    focusSignal(index) {
      const signal = projection.signals.find(s => s.index === index);
      if (!signal) return;
      stage.scrollLeft = Math.max(0, signal.s * prefs.w - (stage.clientWidth - GUTTER_W) / 3);
      focusSignal(signal);
    },
    get prefs() { return { w: prefs.w, h: prefs.h, visible: [...prefs.visible] }; },
    destroy() { observer?.disconnect(); root.innerHTML = ''; },
  });
}
