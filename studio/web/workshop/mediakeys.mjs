// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Media Session keys.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
const SECONDS = 10;
const RATE = 8000;

let el = null;
let hooks = {};

function silentWavUrl() {
  const bytes = SECONDS * RATE;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const tag = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");   v.setUint32(4, 36 + bytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  tag(36, "data");  v.setUint32(40, bytes, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function startSilence() {
  if (!el) {
    el = document.createElement("audio");
    el.loop = true;
    el.src = silentWavUrl();
    el.volume = 1;
    el.muted = false;
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
  }
  el.play().catch(() => {});
}

const stopSilence = () => el?.pause();

export function setState(state) {
  const ms = navigator.mediaSession;
  if (ms) ms.playbackState = state === "stopped" ? "none" : state;
  if (state === "stopped") stopSilence();
  else startSilence();
}

export function init(h = {}) {
  hooks = h;
  const ms = navigator.mediaSession;
  if (!ms) return;
  const on = (name, fn) => { try { ms.setActionHandler(name, fn); } catch {  } };
  on("play",          () => hooks.onPlay?.());
  on("pause",         () => hooks.onPause?.());
  on("stop",          () => hooks.onStop?.());
  on("previoustrack", () => hooks.onSeekBars?.(-1));
  on("nexttrack",     () => hooks.onSeekBars?.(+1));
  on("seekbackward",  () => hooks.onSeekBars?.(-1));
  on("seekforward",   () => hooks.onSeekBars?.(+1));
}
